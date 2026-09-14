import { resolve } from 'node:path';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, type ServerConfig } from './config.ts';
import { initializeDataDirectory, resolveDataDirectory, STATE_DIRECTORY } from './data-directory.ts';
import { acquireProcessLock, type ProcessLock } from './lock.ts';
import { MIGRATIONS } from './migrations.ts';
import { preparePiState } from './pi-state.ts';
import { migrate, openStateDatabase } from './state-db.ts';
import { HEARTBEAT_MS, writeStatus, type ServerStatus } from './status.ts';

export interface StartOptions {
  config: string;
  dataDir: string | undefined;
  cwd: string;
  home: string;
}

export interface RunningServer {
  dataDirectory: string;
  config: ServerConfig;
  schemaVersion: number;
  stop(): Promise<void>;
}

/**
 * Config → data directory → lock → migration → Pi state. Opens no network listener:
 * client connections arrive only once authentication exists.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const config = await loadConfig(resolve(options.cwd, options.config));
  const dataDirectory = await resolveDataDirectory(options.dataDir, options.cwd);
  await initializeDataDirectory(dataDirectory);
  const lock = acquireProcessLock(dataDirectory);
  let db: DatabaseSync | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    db = openStateDatabase(join(dataDirectory, STATE_DIRECTORY, 'state.sqlite'));
    const { version } = migrate(db, MIGRATIONS);
    await preparePiState(config.pi, { dataDirectory, home: options.home });
    const now = new Date().toISOString();
    const status: ServerStatus = { state: 'running', pid: process.pid, startedAt: now, updatedAt: now, schemaVersion: version };
    await writeStatus(dataDirectory, status);
    heartbeat = setInterval(() => {
      void writeStatus(dataDirectory, { ...status, updatedAt: new Date().toISOString() }).catch(() => {});
    }, HEARTBEAT_MS);
    let stopping: Promise<void> | undefined;
    const opened = db;
    return {
      dataDirectory, config, schemaVersion: version,
      stop() {
        stopping ??= (async () => {
          clearInterval(heartbeat);
          try {
            await writeStatus(dataDirectory, { ...status, state: 'stopped', updatedAt: new Date().toISOString() });
          } finally { shutdown(opened, lock); }
        })();
        return stopping;
      },
    };
  } catch (error) {
    clearInterval(heartbeat);
    shutdown(db, lock);
    throw error;
  }
}

function shutdown(db: DatabaseSync | undefined, lock: ProcessLock) {
  try { db?.close(); } finally { lock.release(); }
}
