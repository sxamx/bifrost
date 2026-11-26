import { createApp } from './app.js';
import { loadMasterKeyOrExit } from './crypto.js';
import { openDatabase, writeSystemLog } from './db.js';
import { AUTO_SYNC_INTERVAL_MS, runModelsAutoSyncTick } from './models-sync.js';
import { runNodesHealthTick } from './nodes.js';
import { startBifrostHttpServer } from './server.js';

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

let shuttingDown = false;
const shutdownAbortController = new AbortController();

let healthTickRunning = false;
const triggerNodesHealthTick = () => {
  if (shuttingDown || shutdownAbortController.signal.aborted || healthTickRunning) return;
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

// HU-16: Automatic 6-hour free-model catalog sync for enabled API providers
let modelsSyncTickRunning = false;
const triggerModelsAutoSyncTick = () => {
  if (shuttingDown || shutdownAbortController.signal.aborted || modelsSyncTickRunning) return;
  modelsSyncTickRunning = true;
  void runModelsAutoSyncTick(db, resolved.key)
    .catch(() => {
      // Errors per provider are captured and logged inside runModelsAutoSyncTick
    })
    .finally(() => {
      modelsSyncTickRunning = false;
    });
};

const modelsAutoSyncInterval = setInterval(triggerModelsAutoSyncTick, AUTO_SYNC_INTERVAL_MS);
modelsAutoSyncInterval.unref();

// STB-07: Periodic maintenance (expired sessions cleanup + passive WAL checkpoint ONLY;
// historical usage_logs and system_logs are NEVER automatically deleted).
const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
const triggerSqliteMaintenanceTick = () => {
  if (shuttingDown || shutdownAbortController.signal.aborted) return;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowSec);
    db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  } catch {
    // Non-fatal periodic maintenance error
  }
};

const maintenanceInterval = setInterval(triggerSqliteMaintenanceTick, MAINTENANCE_INTERVAL_MS);
maintenanceInterval.unref();

const server = startBifrostHttpServer(app, {
  port,
  onListening: (info) => {
    process.stdout.write(`[Bifrost] Listening on http://0.0.0.0:${info.port}\n`);
  },
});

const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
let dbClosed = false;

function closeDatabaseOnce(): void {
  if (dbClosed) return;
  dbClosed = true;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // Best-effort WAL truncate before closing
  }
  try {
    db.close();
  } catch {
    // Ignore close errors during shutdown
  }
}

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.stdout.write(`[Bifrost] Received ${signal}, shutting down...\n`);

  shutdownAbortController.abort();
  clearInterval(nodesHeartbeatInterval);
  clearInterval(modelsAutoSyncInterval);
  clearInterval(maintenanceInterval);

  let exited = false;
  const finalizeExit = () => {
    if (exited) return;
    exited = true;
    clearTimeout(forceCloseTimer);
    closeDatabaseOnce();
    process.exit(0);
  };

  const forceCloseTimer = setTimeout(() => {
    try {
      if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    } catch {
      // Ignore connection termination errors
    }
    finalizeExit();
  }, SHUTDOWN_DRAIN_TIMEOUT_MS);
  forceCloseTimer.unref();

  server.close(() => {
    finalizeExit();
  });

  try {
    if ('closeIdleConnections' in server && typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  } catch {
    // Ignore idle connection cleanup errors
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
