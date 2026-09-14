import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STATE_DIRECTORY } from './data-directory.ts';

export class LockError extends Error {
  constructor(message: string) { super(message); this.name = 'LockError'; }
}

export interface ProcessLock { release(): void }

/**
 * Holds an exclusive SQLite (POSIX advisory) lock on `.natsumi/server.lock` for the life of the process.
 * The kernel drops the lock when the process dies, so a crash leaves nothing to clean up and there is
 * no PID file to misjudge across containers or PID reuse. Requires a filesystem with working POSIX locks.
 */
export function acquireProcessLock(dataDirectory: string): ProcessLock {
  const path = join(dataDirectory, STATE_DIRECTORY, 'server.lock');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  } catch (error) {
    db?.close();
    const message = error instanceof Error ? error.message : '';
    if (/locked|busy/i.test(message)) throw new LockError('another natsumi server is already running with this data directory');
    throw new LockError(`cannot lock ${STATE_DIRECTORY}/server.lock: ${message}`);
  }
  let held: DatabaseSync | undefined = db;
  return {
    release() {
      if (!held) return;
      const current = held;
      held = undefined;
      try { current.exec('ROLLBACK'); } finally { current.close(); }
    },
  };
}
