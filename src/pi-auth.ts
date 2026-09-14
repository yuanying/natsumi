import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from './pi-session.ts';

export const COMPATIBLE_PROVIDER = 'natsumi-compatible';
export const COMPATIBLE_KEY_ENV = 'NATSUMI_PI_API_KEY';

export interface CompatibleEndpoint { baseUrl: string; model: string }

export async function subscriptionRuntime(root: string, authPath: string): Promise<ModelRuntime> {
  try { await access(authPath); } catch { throw new Error('Pi subscription login required'); }
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null,
    modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  const credentials = await runtime.listCredentials();
  if (!credentials.some(c => c.providerId === SUBSCRIPTION_TARGET.provider && c.type === 'oauth')) {
    throw new Error('Pi subscription login required');
  }
  return runtime;
}

/**
 * An explicitly chosen OpenAI-compatible Chat Completions endpoint (for example llama.cpp).
 * The key is resolved by Pi from the environment at request time and never stored or logged.
 */
export async function compatibleRuntime(root: string, endpoint: CompatibleEndpoint,
  env: Record<string, string | undefined> = process.env): Promise<ModelRuntime> {
  if (!env[COMPATIBLE_KEY_ENV]) throw new Error('Compatible endpoint API key required');
  let url: URL;
  try { url = new URL(endpoint.baseUrl); } catch { throw new Error('Compatible endpoint must use https'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Compatible endpoint must use https');
  }
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(COMPATIBLE_PROVIDER, {
    name: 'OpenAI-compatible endpoint', baseUrl: endpoint.baseUrl, api: 'openai-completions',
    apiKey: `$${COMPATIBLE_KEY_ENV}`,
    models: [{
      id: endpoint.model, name: endpoint.model, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
      // Qwen-style chat templates: keep the probe fast and deterministic without thinking output.
      samplingParams: { chat_template_kwargs: { enable_thinking: false } },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: 'max_tokens' },
    }],
  });
  return runtime;
}
