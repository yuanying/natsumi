import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { COMPATIBLE_KEY_ENV } from '../pi/auth.ts';

export type ProbeRoute =
  | { kind: 'subscription'; authPath: string }
  | { kind: 'compatible'; baseUrl: string; model: string };

/** Exactly one explicit route. There is no implicit fallback between them. Keys never come from argv. */
export function parseProbeArgs(argv: string[], env: Record<string, string | undefined>): ProbeRoute {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    'auth-path': { type: 'string' },
    'compatible-base-url': { type: 'string' },
    'compatible-model': { type: 'string' },
  } });
  const authPath = values['auth-path'];
  const baseUrl = values['compatible-base-url'];
  const model = values['compatible-model'];
  const compatible = baseUrl !== undefined || model !== undefined;
  if ((authPath !== undefined) === compatible) throw new Error('missing-route');
  if (authPath !== undefined) {
    if (!isAbsolute(authPath)) throw new Error('missing-auth');
    return { kind: 'subscription', authPath };
  }
  if (!baseUrl || !model) throw new Error('missing-route');
  if (!env[COMPATIBLE_KEY_ENV]) throw new Error('missing-key');
  return { kind: 'compatible', baseUrl, model };
}
