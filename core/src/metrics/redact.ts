const SENSITIVE_FIELD_RE =
  /^(password|password_hash|passwordHash|secret|encrypted_secret|encryptedSecret|encrypted_token|encryptedToken|rawKey|raw_key|rawToken|raw_token|nodeToken|node_token|newToken|new_token|inviteUrl|invite_url|apiKey|api_key|x-api-key|x-goog-api-key|token|token_hash|tokenHash|prev_token_hash|masterKey|master_key|authorization|proxy-authorization|proxy_authorization|cookie)$/i;

/**
 * Redacts explicit secret values (literal + URL-encoded, length >= 6) and common API key,
 * bearer/basic token, node token, internal sk-bf- key, and query-param patterns from text.
 */
export function redactSecretsInText(
  text: string,
  explicitSecrets?: ReadonlyArray<string | null | undefined>,
): string {
  let out = text;
  if (explicitSecrets && explicitSecrets.length > 0) {
    const uniqueSecrets = Array.from(
      new Set(
        explicitSecrets.filter(
          (secret): secret is string => typeof secret === 'string' && secret.length >= 6,
        ),
      ),
    ).sort((a, b) => b.length - a.length);

    for (const secret of uniqueSecrets) {
      out = out.split(secret).join('[REDACTED]');
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret && encoded.length >= 6) {
        out = out.split(encoded).join('[REDACTED]');
      }
    }
  }

  return out
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
