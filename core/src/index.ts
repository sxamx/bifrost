import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadMasterKeyOrExit } from './crypto.js';
import { openDatabase, writeSystemLog } from './db.js';

const resolved = loadMasterKeyOrExit();
const db = openDatabase(resolved.dbPath);

writeSystemLog(db, 'info', 'system', 'Bifrost server initialized', {
  masterKeySource: resolved.source,
});

const port = Number(process.env.PORT ?? 8080);
const app = createApp({
  db,
  masterKey: resolved.key,
  panelDistDir: process.env.PANEL_DIST_DIR,
});

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    process.stdout.write(`[Bifrost] Listening on http://0.0.0.0:${info.port}\n`);
  },
);

function shutdown(signal: string): void {
  process.stdout.write(`[Bifrost] Received ${signal}, shutting down...\n`);
  server.close(() => {
    try {
      db.close();
    } catch {
      // Ignore close errors during shutdown
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
