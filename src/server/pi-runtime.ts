import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { compatibleRuntimeWithKey, subscriptionRuntime } from '../pi-auth.ts';
import type { PiTarget } from '../pi-session.ts';
import type { PiConfig } from './config.ts';
import { readSecret } from './secrets.ts';

/** The configured model route cannot be used (no login, no key). The message never carries paths or values. */
export class PiUnavailableError extends Error {
  constructor() { super('the configured Pi model route is not ready: log in or provide its API key'); this.name = 'PiUnavailableError'; }
}

/**
 * The model runtime for `pi.model`. The compatible endpoint uses only its referenced key; every other provider uses
 * only the OAuth login in the dedicated auth file. Neither route falls back to the other (ADR 0004).
 */
export async function createModelRuntime(pi: PiConfig, env: Record<string, string | undefined>): Promise<{ runtime: ModelRuntime; target: PiTarget }> {
  const target = { provider: pi.model.provider, model: pi.model.id };
  try {
    if (pi.compatible) {
      // Resolved once at startup from the server's own reference; a rotated key takes effect on restart.
      const key = await readSecret(pi.compatible.apiKey, 'pi.compatible.apiKey', env);
      return { runtime: await compatibleRuntimeWithKey(pi.agentDirectory, { baseUrl: pi.compatible.baseUrl, model: pi.model.id }, key), target };
    }
    return { runtime: await subscriptionRuntime(pi.agentDirectory, pi.authPath, pi.model.provider), target };
  } catch {
    throw new PiUnavailableError();
  }
}
