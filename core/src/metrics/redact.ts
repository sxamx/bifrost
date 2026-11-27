const SENSITIVE_FIELD_RE =
  /^(password|password_hash|passwordHash|secret|encrypted_secret|encryptedSecret|encrypted_token|encryptedToken|rawKey|raw_key|rawToken|raw_token|nodeToken|node_token|newToken|new_token|inviteUrl|invite_url|apiKey|api_key|x-api-key|x-goog-api-key|token|token_hash|tokenHash|prev_token_hash|masterKey|master_key|authorization|proxy-authorization|proxy_authorization|cookie)$/i;

/**
 * Redacts explicit raw secrets (both literal and encodeURIComponent-encoded variants,
 * longest-first) before regex-based scrubbing or truncation so arbitrary vendor key formats
 * and special characters (+, /, =, :) can never leak.
 */
export function redactExplicitSecrets(
  text: string,
  explicitSecrets?: ReadonlyArray<string | null | undefined>,
): string {
  if (!text || !explicitSecrets || explicitSecrets.length === 0) {
    return text;
  }
  const variants = new Set<string>();
  for (const raw of explicitSecrets) {
    if (typeof raw !== 'string' || raw.length < 4) continue;
    variants.add(raw);
    try {
      const encoded = encodeURIComponent(raw);
      if (encoded && encoded !== raw && encoded.length >= 4) {
        variants.add(encoded);
      }
    } catch {
      // Ignore malformed UTF-16 sequences
    }
  }
  if (variants.size === 0) {
    return text;
  }
  const sorted = Array.from(variants).sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of sorted) {
    out = out.split(needle).join('[REDACTED]');
  }
  return out;
}

/**
 * Redacts explicit secret values (literal + URL-encoded) and common API key,
 * bearer/basic token, node token, internal sk-bf- key, and query-param patterns from text.
 */
export function redactSecretsInText(
  text: string,
  explicitSecrets?: ReadonlyArray<string | null | undefined>,
): string {
  return redactExplicitSecrets(text, explicitSecrets)
    .replace(/sk-bf-[A-Za-z0-9_-]{6,}/g, 'sk-bf-[REDACTED]')
    .replace(/bfnode_[A-Za-z0-9_-]{6,}/g, 'bfnode_[REDACTED]')
    .replace(/bfn_[A-Za-z0-9_-]{6,}/g, 'bfn_[REDACTED]')
    .replace(/bfi_[A-Za-z0-9_-]{6,}/g, 'bfi_[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-[REDACTED]')
    .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, 'nvapi-[REDACTED]')
    .replace(/gsk_[A-Za-z0-9_-]{10,}/g, 'gsk_[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{16,}/g, 'AIza[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"'#]+/gi, '$1[REDACTED]');
}

/**
 * Scrubs raw API keys, bearer/basic tokens, node tokens, internal sk-bf- keys, query params, and provider prefixes from log strings.
 */
export function scrubSecretsFromText(
  text: string,
  explicitSecrets?: ReadonlyArray<string | null | undefined>,
): string {
  return redactSecretsInText(text, explicitSecrets);
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
