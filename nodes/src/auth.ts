import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';

export const DEFAULT_GRACE_WINDOW_MS = 300_000; // 5 minutes per PROTOCOLO-NODOS.md

export interface TokenVerificationResult {
  authenticated: boolean;
  matchedSlot?: 'active' | 'previous';
}

export interface PersistedTokenState {
  activeTokenHashHex: string;
  prevTokenHashHex?: string | null;
  prevTokenExpiresAtMs?: number | null;
  updatedAt: number;
}

export interface TokenAuthenticatorOptions {
  initialToken?: string;
  stateFilePath?: string;
  graceWindowMs?: number;
  now?: () => number;
}

export function sha256Buffer(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function parseBearerHeader(headerValue: string | string[] | undefined): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(raw.trim());
  return match ? match[1] : null;
}

/**
 * Extracts a Bearer token from Proxy-Authorization (primary) or Authorization (fallback).
 */
export function extractBearerToken(headers: IncomingHttpHeaders): string | null {
  return (
    parseBearerHeader(headers['proxy-authorization']) ??
    parseBearerHeader(headers['authorization'])
  );
}

/**
 * Constant-time SHA-256 token authenticator supporting zero-downtime token rotation
 * with a configurable grace window (default 300,000 ms = 5 minutes).
 */
export class TokenAuthenticator {
  private activeTokenHash: Buffer;
  private prevTokenHash: Buffer | null = null;
  private prevTokenExpiresAtMs: number | null = null;
  private readonly graceWindowMs: number;
  private readonly stateFilePath?: string;
  private readonly now: () => number;

  constructor(options: TokenAuthenticatorOptions) {
    this.graceWindowMs = options.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
    this.stateFilePath = options.stateFilePath;
    this.now = options.now ?? (() => Date.now());

    const loadedState = this.loadStateFile();
    if (loadedState) {
      this.activeTokenHash = loadedState.activeTokenHash;
      this.prevTokenHash = loadedState.prevTokenHash;
      this.prevTokenExpiresAtMs = loadedState.prevTokenExpiresAtMs;
    } else if (options.initialToken && options.initialToken.trim().length > 0) {
      this.activeTokenHash = sha256Buffer(options.initialToken.trim());
      this.persistStateFile();
    } else {
      throw new Error(
        'Missing node authentication token: provide --token / BIFROST_NODE_TOKEN or an initialized state file.'
      );
    }
  }

  private loadStateFile(): {
    activeTokenHash: Buffer;
    prevTokenHash: Buffer | null;
    prevTokenExpiresAtMs: number | null;
  } | null {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) {
      return null;
    }
    const raw = fs.readFileSync(this.stateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedTokenState>;
    if (
      typeof parsed.activeTokenHashHex !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(parsed.activeTokenHashHex)
    ) {
      throw new Error(`Invalid persisted token hash in ${this.stateFilePath}`);
    }

    const activeTokenHash = Buffer.from(parsed.activeTokenHashHex, 'hex');
    let prevTokenHash: Buffer | null = null;
    let prevTokenExpiresAtMs: number | null = null;

    if (
      typeof parsed.prevTokenHashHex === 'string' &&
      /^[0-9a-f]{64}$/i.test(parsed.prevTokenHashHex) &&
      typeof parsed.prevTokenExpiresAtMs === 'number' &&
      Number.isFinite(parsed.prevTokenExpiresAtMs) &&
      this.now() < parsed.prevTokenExpiresAtMs
    ) {
      prevTokenHash = Buffer.from(parsed.prevTokenHashHex, 'hex');
      prevTokenExpiresAtMs = parsed.prevTokenExpiresAtMs;
    }

    return { activeTokenHash, prevTokenHash, prevTokenExpiresAtMs };
  }

  private persistStateFile(): void {
    if (!this.stateFilePath) {
      return;
    }
    const dir = path.dirname(this.stateFilePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const currentMs = this.now();
    this.pruneExpiredGraceToken(currentMs);
    const payload: PersistedTokenState = {
      activeTokenHashHex: this.activeTokenHash.toString('hex'),
      prevTokenHashHex: this.prevTokenHash ? this.prevTokenHash.toString('hex') : null,
      prevTokenExpiresAtMs: this.prevTokenHash ? this.prevTokenExpiresAtMs : null,
      updatedAt: Math.floor(currentMs / 1000)
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const tmpPath = `${this.stateFilePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmpPath, 'w', 0o600);
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      if (process.platform !== 'win32') {
        fs.chmodSync(tmpPath, 0o600);
      }
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close error on cleanup
        }
      }
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup error
      }
      throw err;
    }
  }

  private pruneExpiredGraceToken(currentMs: number): void {
    if (this.prevTokenExpiresAtMs !== null && currentMs >= this.prevTokenExpiresAtMs) {
      this.prevTokenHash = null;
      this.prevTokenExpiresAtMs = null;
    }
  }

  public verifyToken(candidateToken: string | null | undefined): TokenVerificationResult {
    if (!candidateToken || typeof candidateToken !== 'string') {
      return { authenticated: false };
    }

    const currentMs = this.now();
    this.pruneExpiredGraceToken(currentMs);

    const candidateHash = sha256Buffer(candidateToken);

    if (
      candidateHash.length === this.activeTokenHash.length &&
      crypto.timingSafeEqual(candidateHash, this.activeTokenHash)
    ) {
      return { authenticated: true, matchedSlot: 'active' };
    }

    if (
      this.prevTokenHash !== null &&
      this.prevTokenExpiresAtMs !== null &&
      currentMs < this.prevTokenExpiresAtMs &&
      candidateHash.length === this.prevTokenHash.length &&
      crypto.timingSafeEqual(candidateHash, this.prevTokenHash)
    ) {
      return { authenticated: true, matchedSlot: 'previous' };
    }

    return { authenticated: false };
  }

  public verifyHeaders(headers: IncomingHttpHeaders): TokenVerificationResult {
    return this.verifyToken(extractBearerToken(headers));
  }

  public rotate(newToken: string): { graceWindowMs: number; prevTokenExpiresAtSec: number } {
    const trimmed = newToken.trim();
    if (trimmed.length < 16) {
      throw new Error('newToken must be at least 16 characters long');
    }

    const nextHash = sha256Buffer(trimmed);
    const currentMs = this.now();

    // Idempotent if called twice with the exact same active token
    if (crypto.timingSafeEqual(nextHash, this.activeTokenHash)) {
      const expiresAtMs = this.prevTokenExpiresAtMs ?? currentMs + this.graceWindowMs;
      return {
        graceWindowMs: this.graceWindowMs,
        prevTokenExpiresAtSec: Math.floor(expiresAtMs / 1000)
      };
    }

    const prevActiveHash = this.activeTokenHash;
    const prevGraceHash = this.prevTokenHash;
    const prevGraceExpiresAtMs = this.prevTokenExpiresAtMs;

    this.prevTokenHash = this.activeTokenHash;
    this.prevTokenExpiresAtMs = currentMs + this.graceWindowMs;
    this.activeTokenHash = nextHash;
    try {
      this.persistStateFile();
    } catch (err) {
      this.activeTokenHash = prevActiveHash;
      this.prevTokenHash = prevGraceHash;
      this.prevTokenExpiresAtMs = prevGraceExpiresAtMs;
      throw err;
    }

    return {
      graceWindowMs: this.graceWindowMs,
      prevTokenExpiresAtSec: Math.floor(this.prevTokenExpiresAtMs / 1000)
    };
  }
}
