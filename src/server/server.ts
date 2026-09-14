import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, type ServerConfig } from './config.ts';
import { ConnectionHub } from './connections.ts';
import { initializeDataDirectory, resolveDataDirectory, STATE_DIRECTORY } from './data-directory.ts';
import { GITHUB_ENDPOINTS, GitHubLogin, type GitHubEndpoints } from './github-login.ts';
import { bearerToken, openListener, type Listener } from './http.ts';
import { acquireProcessLock, type ProcessLock } from './lock.ts';
import { MIGRATIONS } from './migrations.ts';
import { preparePiState } from './pi-state.ts';
import { readSecret, readTlsFiles } from './secrets.ts';
import { SessionStore } from './sessions.ts';
import { migrate, openStateDatabase } from './state-db.ts';
import { HEARTBEAT_MS, writeStatus, type ServerStatus } from './status.ts';

const SESSION_SWEEP_MS = 30_000;

export interface StartOptions {
  config: string;
  dataDir: string | undefined;
  cwd: string;
  home: string;
  /** Where `...Env` secret references are looked up. */
  env: Record<string, string | undefined>;
  /** GitHub's endpoints. Tests point these at a local stub. */
  github?: GitHubEndpoints;
  clock?: () => number;
  /** Receives fixed event lines only: never secrets, tokens or upstream response bodies. */
  log?: (line: string) => void;
}

export interface RunningServer {
  dataDirectory: string;
  config: ServerConfig;
  schemaVersion: number;
  address: { host: string; port: number };
  /** Closes connections whose session has expired (also runs periodically). */
  expireSessions(): void;
  stop(): Promise<void>;
}

/**
 * Config and secrets → data directory → lock → migration → Pi state → authenticated listener.
 * No listener opens without GitHub authentication in front of it.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const config = await loadConfig(resolve(options.cwd, options.config));
  const clientSecret = await readSecret(config.github.clientSecret, 'github.clientSecret', options.env);
  const tlsFiles = config.listen.tls ? await readTlsFiles(config.listen.tls, 'listen.tls') : undefined;
  const now = options.clock ?? Date.now;
  const log = options.log ?? (() => {});
  const dataDirectory = await resolveDataDirectory(options.dataDir, options.cwd);
  await initializeDataDirectory(dataDirectory);
  const lock = acquireProcessLock(dataDirectory);
  let db: DatabaseSync | undefined;
  let listener: Listener | undefined;
  const timers: NodeJS.Timeout[] = [];
  try {
    db = openStateDatabase(join(dataDirectory, STATE_DIRECTORY, 'state.sqlite'));
    const { version } = migrate(db, MIGRATIONS);
    await preparePiState(config.pi, { dataDirectory, home: options.home });

    const sessions = new SessionStore(db, now);
    const allowedUserId = config.github.allowedUserId;
    const hub = new ConnectionHub({
      publicOrigin: config.publicOrigin, now,
      authenticate: request => {
        const token = bearerToken(request);
        return token ? sessions.verify(token, allowedUserId) : undefined;
      },
    });
    const login = new GitHubLogin({ config: config.github, clientSecret, endpoints: options.github ?? GITHUB_ENDPOINTS, sessions, now, log });
    listener = await openListener({ listen: config.listen, tlsFiles, login, sessions, hub, allowedUserId, log });

    const started = new Date().toISOString();
    const status: ServerStatus = { state: 'running', pid: process.pid, startedAt: started, updatedAt: started, schemaVersion: version };
    await writeStatus(dataDirectory, status);
    timers.push(setInterval(() => {
      void writeStatus(dataDirectory, { ...status, updatedAt: new Date().toISOString() }).catch(() => {});
    }, HEARTBEAT_MS));
    timers.push(setInterval(() => hub.expireSessions(), SESSION_SWEEP_MS));

    let stopping: Promise<void> | undefined;
    const opened = { db, listener };
    return {
      dataDirectory, config, schemaVersion: version, address: listener.address,
      expireSessions: () => hub.expireSessions(),
      stop() {
        stopping ??= (async () => {
          timers.forEach(clearInterval);
          try {
            await opened.listener.close();
            await writeStatus(dataDirectory, { ...status, state: 'stopped', updatedAt: new Date().toISOString() });
          } finally { shutdown(opened.db, lock); }
        })();
        return stopping;
      },
    };
  } catch (error) {
    timers.forEach(clearInterval);
    try { await listener?.close(); } finally { shutdown(db, lock); }
    throw error;
  }
}

function shutdown(db: DatabaseSync | undefined, lock: ProcessLock) {
  try { db?.close(); } finally { lock.release(); }
}
