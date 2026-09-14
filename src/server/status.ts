import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIRECTORY } from './data-directory.ts';

export interface ServerStatus {
  /** `waiting-for-certificate`: ACME has not yet obtained the first certificate, so HTTPS is not open. */
  state: 'running' | 'waiting-for-certificate' | 'stopped';
  pid: number;
  startedAt: string;
  updatedAt: string;
  schemaVersion: number;
}

export const HEARTBEAT_MS = 15_000;
const STALE_MS = 3 * HEARTBEAT_MS;

const statusPath = (dataDirectory: string) => join(dataDirectory, STATE_DIRECTORY, 'status.json');

/** Health is exposed as a local file, not a network listener. Written atomically by rename. */
export async function writeStatus(dataDirectory: string, status: ServerStatus): Promise<void> {
  const path = statusPath(dataDirectory);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(status) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function readStatus(dataDirectory: string): Promise<ServerStatus | undefined> {
  try { return JSON.parse(await readFile(statusPath(dataDirectory), 'utf8')) as ServerStatus; } catch { return undefined; }
}

export function checkHealth(status: ServerStatus | undefined, now = Date.now()): { healthy: boolean; reason: string } {
  if (!status) return { healthy: false, reason: 'no status' };
  if (status.state !== 'running') return { healthy: false, reason: status.state };
  const age = now - Date.parse(status.updatedAt);
  if (!(age <= STALE_MS)) return { healthy: false, reason: 'heartbeat stale' };
  return { healthy: true, reason: 'running' };
}
