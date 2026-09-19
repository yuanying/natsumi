/**
 * How natsumi names and describes an OpenAI-compatible endpoint. The config parser and the Pi runtime must agree on
 * both, and the parser must not have to load Pi's SDK to check a config file, so they live here rather than in
 * `auth.ts`. Nothing here imports.
 */

/** The provider a compatible endpoint is registered under. Configured models name it; no other provider is accepted. */
export const COMPATIBLE_PROVIDER = 'natsumi-compatible';

/** An explicitly chosen Chat Completions endpoint and the one model it serves. */
export interface CompatibleEndpoint { baseUrl: string; model: string }
