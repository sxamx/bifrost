#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BifrostNodeOptions,
  DEFAULT_NODE_PORT,
  NODE_AGENT_VERSION,
  type NodeMode,
  createBifrostNodeServer
} from './server.js';

export * from './auth.js';
export * from './ssrf.js';
export * from './tailscale.js';
export * from './tls.js';
export * from './server.js';

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): BifrostNodeOptions & { help?: boolean } {
  let mode: NodeMode = (env.BIFROST_NODE_MODE as NodeMode | undefined) ?? 'tailscale';
  let port: number = env.BIFROST_NODE_PORT ? Number(env.BIFROST_NODE_PORT) : DEFAULT_NODE_PORT;
  let bindHost: string | undefined = env.BIFROST_NODE_BIND_HOST;
  let token: string | undefined = env.BIFROST_NODE_TOKEN;
  let stateFilePath: string | undefined = env.BIFROST_NODE_STATE_FILE;
  let tlsCertPath: string | undefined = env.BIFROST_NODE_TLS_CERT;
  let tlsKeyPath: string | undefined = env.BIFROST_NODE_TLS_KEY;
  let tlsPersistDir: string | undefined = env.BIFROST_NODE_DATA_DIR;
  let graceWindowMs: number | undefined = env.BIFROST_NODE_GRACE_MS ? Number(env.BIFROST_NODE_GRACE_MS) : undefined;
  let allowedPorts: number[] | undefined = env.BIFROST_NODE_ALLOWED_PORTS
    ? env.BIFROST_NODE_ALLOWED_PORTS.split(',').map((p) => Number(p.trim())).filter(Number.isInteger)
    : undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eqIdx = arg.indexOf('=');
    const flag = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
    const inlineVal = eqIdx !== -1 ? arg.slice(eqIdx + 1) : undefined;
    const nextVal = () => {
      if (inlineVal !== undefined) return inlineVal;
      i += 1;
      return argv[i];
    };

    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--mode': {
        const val = nextVal();
        if (val !== 'tailscale' && val !== 'public_ip') {
          throw new Error(`Invalid --mode "${String(val)}" (expected "tailscale" or "public_ip")`);
        }
        mode = val;
        break;
      }
      case '--port': {
        const val = Number(nextVal());
        if (!Number.isInteger(val) || val < 1 || val > 65535) {
          throw new Error(`Invalid --port "${String(val)}"`);
        }
        port = val;
        break;
      }
      case '--bind-host':
        bindHost = nextVal();
        break;
      case '--token':
        token = nextVal();
        break;
      case '--state-file':
        stateFilePath = nextVal();
        break;
      case '--data-dir':
        tlsPersistDir = nextVal();
        break;
      case '--tls-cert':
        tlsCertPath = nextVal();
        break;
      case '--tls-key':
        tlsKeyPath = nextVal();
        break;
      case '--grace-ms':
        graceWindowMs = Number(nextVal());
        break;
      case '--allowed-ports': {
        const raw = nextVal() ?? '';
        allowedPorts = raw
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
        break;
      }
      default:
        throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (tlsPersistDir && !stateFilePath) {
    stateFilePath = path.join(tlsPersistDir, 'token-state.json');
  }

  return {
    help,
    mode,
    port,
    bindHost,
    token,
    stateFilePath,
    tlsCertPath,
    tlsKeyPath,
    tlsPersistDir,
    graceWindowMs,
    allowedPorts
  };
}

function printHelp(): void {
  console.log(`Bifrost Egress Node Agent (v${NODE_AGENT_VERSION})

Usage:
  bifrost-node [options]

Options:
  --mode <tailscale|public_ip>  Listener transport mode (default: tailscale)
  --port <port>                 Listening port (default: 9443)
  --token <token>               Initial node authentication token (or BIFROST_NODE_TOKEN)
  --data-dir <dir>              Directory for persisted token hash & TLS cert
  --state-file <path>           Path to persisted SHA-256 token state file (0600)
  --tls-cert <path>             TLS certificate PEM path (public_ip mode)
  --tls-key <path>              TLS private key PEM path (public_ip mode)
  --allowed-ports <list>        Comma-separated allowed target ports (default: 443)
  --help, -h                    Show this help message
`);
}

async function main(): Promise<void> {
  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    if (parsed.help) {
      printHelp();
      return;
    }

    const instance = createBifrostNodeServer(parsed);
    await instance.start();

    const shutdown = async (signal: string) => {
      console.log(`[bifrost-node] Recibido ${signal}, cerrando túneles de forma ordenada...`);
      await instance.stop();
      process.exit(0);
    };

    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('[bifrost-node][WARN]')) {
      console.error(`[bifrost-node][ERROR] ${message}`);
    }
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  void main();
}
