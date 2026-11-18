import { execFileSync } from 'node:child_process';
import os from 'node:os';

/**
 * Checks whether an IPv4 address belongs to the Tailscale / CGNAT range 100.64.0.0/10
 * (100.64.0.0 through 100.127.255.255).
 */
export function isTailscaleCgnatIpv4(ip: string): boolean {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) {
    return false;
  }
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  return nums[0] === 100 && (nums[1] & 0xc0) === 64;
}

export interface DetectTailscaleOptions {
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  execTailscaleCli?: () => string | null;
}

/**
 * Detects the active Tailscale IPv4 address via os.networkInterfaces() (preferred)
 * or `tailscale ip -4` CLI fallback.
 */
export function detectTailscaleIpv4(options: DetectTailscaleOptions = {}): string | null {
  const interfaces = options.interfaces ?? os.networkInterfaces();
  const preferredMatches: string[] = [];
  const fallbackMatches: string[] = [];

  for (const [ifName, infos] of Object.entries(interfaces)) {
    if (!infos) continue;
    const lowerName = ifName.toLowerCase();
    const isLikelyTailscaleIf =
      lowerName.startsWith('tailscale') || lowerName.startsWith('ts') || lowerName.startsWith('utun');

    for (const info of infos) {
      if (info.family === 'IPv4' && !info.internal && isTailscaleCgnatIpv4(info.address)) {
        if (isLikelyTailscaleIf) {
          preferredMatches.push(info.address);
        } else {
          fallbackMatches.push(info.address);
        }
      }
    }
  }

  if (preferredMatches.length > 0) {
    return preferredMatches[0];
  }
  if (fallbackMatches.length > 0) {
    return fallbackMatches[0];
  }

  const cliRunner =
    options.execTailscaleCli ??
    (() => {
      try {
        return execFileSync('tailscale', ['ip', '-4'], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch {
        return null;
      }
    });

  const cliOut = cliRunner();
  if (cliOut) {
    for (const line of cliOut.split(/\r?\n/)) {
      const candidate = line.trim();
      if (isTailscaleCgnatIpv4(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function formatMissingTailscaleMessage(port: number): string {
  return [
    '[bifrost-node][WARN] No se detectó una interfaz Tailscale activa (rango 100.64.0.0/10) para --mode=tailscale.',
    '  Opciones recomendadas:',
    '  1) Instala y conecta Tailscale (`tailscale up`) y vuelve a iniciar el nodo (opción recomendada, sin abrir puertos públicos).',
    `  2) Si esta VM no usa Tailscale, inicia explícitamente en modo IP pública sobre TLS: --mode=public_ip --port=${port}`
  ].join('\n');
}
