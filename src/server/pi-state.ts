import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PiConfig } from './config.ts';
import { findCodeCheckout, isWithin, realPathAllowingMissing } from './paths.ts';

export class PiStateError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) { super(`${path}: ${reason}`); this.name = 'PiStateError'; this.path = path; }
}

/**
 * Validates and creates the dedicated Pi state area: agentDir, session store and the auth file's directory.
 * It never creates or edits the auth file; the owner logs in to this dedicated area separately.
 */
export async function preparePiState(pi: PiConfig, options: { dataDirectory: string; home: string }): Promise<void> {
  const home = await realPathAllowingMissing(options.home);
  const personal = [join(home, '.pi'), join(home, '.codex')];
  const entries = [
    ['pi.agentDirectory', pi.agentDirectory],
    ['pi.sessionDirectory', pi.sessionDirectory],
    ['pi.authPath', pi.authPath],
  ] as const;
  for (const [setting, path] of entries) {
    const real = await realPathAllowingMissing(path);
    if (isWithin(real, options.dataDirectory) || isWithin(options.dataDirectory, real)) {
      throw new PiStateError(setting, 'must be outside the data directory');
    }
    if (personal.some(dir => isWithin(real, dir))) {
      throw new PiStateError(setting, 'must not use the personal Pi or Codex configuration');
    }
    if (await findCodeCheckout(real)) throw new PiStateError(setting, 'must be outside the natsumi code checkout');
  }
  for (const dir of [pi.agentDirectory, pi.sessionDirectory, dirname(pi.authPath)]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}
