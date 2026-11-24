import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';

export interface StartBifrostHttpServerOptions {
  port: number;
  hostname?: string;
  onListening?: (info: AddressInfo) => void;
}

/**
 * Starts Bifrost's Node HTTP server via `@hono/node-server` with TCP_NODELAY (`noDelay: true`)
 * explicitly enabled so SSE chunks flush over the socket immediately without Nagle buffering.
 */
export function startBifrostHttpServer(
  app: { fetch: Parameters<typeof serve>[0]['fetch'] },
  options: StartBifrostHttpServerOptions,
): ServerType {
  return serve(
    {
      fetch: app.fetch,
      port: options.port,
      hostname: options.hostname,
      serverOptions: {
        noDelay: true,
      },
    },
    options.onListening,
  );
}
