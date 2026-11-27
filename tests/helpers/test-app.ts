import type http from 'node:http';
import type https from 'node:https';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const EMPTY_MODELS_DEV_URLS = new Set([
  'https://models.dev/api.json',
  'https://models.dev/models.json',
]);

export type OfflineFetchInput = Parameters<typeof fetch>[0];
export type OfflineFetchInit = Parameters<typeof fetch>[1];

export type OfflineFetchCustomHandler = (
  input: OfflineFetchInput,
  init?: OfflineFetchInit,
) => Response | undefined | Promise<Response | undefined>;

function extractRequestUrl(input: OfflineFetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Creates a fail-closed offline `fetch` implementation for tests.
 * - Returns `{}` (HTTP 200 JSON) for `https://models.dev/api.json` and
 *   `https://models.dev/models.json` so model sync and catalog lookups never
 *   perform live HTTPS requests.
 * - Delegates to `customHandler` when provided and it returns a `Response`.
 * - Allows loopback hosts (`127.0.0.1`, `localhost`, `::1`) via `globalThis.fetch`
 *   so local mock HTTP/HTTPS servers created by tests keep working.
 * - Rejects any other external host with an explicit error.
 */
export function createOfflineFetch(customHandler?: OfflineFetchCustomHandler): typeof fetch {
  const realFetch = globalThis.fetch.bind(globalThis);

  const offlineFetch: typeof fetch = async (input, init) => {
    const url = extractRequestUrl(input);

    if (EMPTY_MODELS_DEV_URLS.has(url)) {
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (customHandler) {
      const handled = await customHandler(input, init);
      if (handled !== undefined) {
        return handled;
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`[offline-fetch] Blocked invalid or unmocked URL: ${url}`);
    }

    if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return realFetch(input, init);
    }

    throw new Error(`[offline-fetch] Blocked unmocked external network request: ${url}`);
  };

  return offlineFetch;
}

/**
 * Closes an HTTP or HTTPS test server deterministically by terminating active
 * keep-alive connections before awaiting `server.close()`.
 */
export async function closeHttpServer(server: http.Server | https.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
