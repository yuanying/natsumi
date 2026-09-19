import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { compatibleProvider, emptyRuntime } from '../pi/auth.ts';
import { COMPATIBLE_PROVIDER, type CompatibleEndpoint } from '../pi/compatible.ts';

export const COMPATIBLE_KEY_ENV = 'NATSUMI_PI_API_KEY';

/**
 * The compatible endpoint as the probe reaches it: the key is resolved by Pi from the environment at request time
 * and never stored or logged. The server does not take this route; it resolves its own key first
 * (`compatibleRuntimeWithKey`), so only the probe needs an environment variable.
 */
export async function compatibleRuntime(root: string, endpoint: CompatibleEndpoint,
  env: Record<string, string | undefined> = process.env): Promise<ModelRuntime> {
  if (!env[COMPATIBLE_KEY_ENV]) throw new Error('Compatible endpoint API key required');
  const runtime = await emptyRuntime(root, endpoint);
  runtime.registerProvider(COMPATIBLE_PROVIDER, { ...compatibleProvider(endpoint), apiKey: `$${COMPATIBLE_KEY_ENV}` });
  return runtime;
}
