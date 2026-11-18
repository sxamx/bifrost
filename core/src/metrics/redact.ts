const SENSITIVE_FIELD_RE =
  /^(password|password_hash|passwordHash|secret|encrypted_secret|encryptedSecret|encrypted_token|encryptedToken|rawKey|raw_key|rawToken|raw_token|apiKey|api_key|token|token_hash|tokenHash|prev_token_hash|masterKey|master_key|authorization|proxy_authorization|cookie)$/i;

/**
 * Scrubs raw API keys, bearer tokens, node tokens, internal sk-bf- keys, and provider prefixes from log strings.
 */
export function scrubSecretsFromText(text: string): string {
  return text
    .replace(/sk-bf-[A-Za-z0-9_-]{6,}/g, 'sk-bf-[REDACTED]')
    .replace(/bfnode_[A-Za-z0-9_-]{6,}/g, 'bfnode_[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-[REDACTED]')
    .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, 'nvapi-[REDACTED]')
    .replace(/gsk_[A-Za-z0-9_-]{10,}/g, 'gsk_[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{16,}/g, 'AIza[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
}

export function scrubMetaValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return scrubSecretsFromText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubMetaValue(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = scrubMetaValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function parseAndScrubMetaJson(metaJson: string | null): Record<string, unknown> | unknown | null {
  if (metaJson === null || metaJson === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    return scrubMetaValue(parsed);
  } catch {
    return scrubSecretsFromText(metaJson);
  }
}
