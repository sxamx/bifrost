import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadMasterKeyOrExit } from './crypto.js';
import { openDatabase, writeSystemLog } from './db.js';
import { runNodesHealthTick } from './nodes.js';

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

let healthTickRunning = false;
const triggerNodesHealthTick = () => {
  if (healthTickRunning) return;
  healthTickRunning = true;
  void runNodesHealthTick(db, resolved.key)
    .catch(() => {
      // Errors per node are captured inside runNodesHealthTick
    })
    .finally(() => {
      healthTickRunning = false;
    });
};

// Initial sweep + 30-second periodic heartbeat & 24h token rotation check (HU-12, HU-11c)
triggerNodesHealthTick();
const nodesHeartbeatInterval = setInterval(triggerNodesHealthTick, 30_000);
nodesHeartbeatInterval.unref();

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
  clearInterval(nodesHeartbeatInterval);
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
