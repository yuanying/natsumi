import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from './pi-session.ts';

export const COMPATIBLE_PROVIDER = 'natsumi-compatible';
export const COMPATIBLE_KEY_ENV = 'NATSUMI_PI_API_KEY';

export interface CompatibleEndpoint { baseUrl: string; model: string }

/** A runtime that uses only the OAuth login stored at `authPath` for `provider`. No API key route exists here. */
export async function subscriptionRuntime(root: string, authPath: string, provider = SUBSCRIPTION_TARGET.provider): Promise<ModelRuntime> {
  try { await access(authPath); } catch { throw new Error('Pi subscription login required'); }
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null,
    modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  const credentials = await runtime.listCredentials();
  if (!credentials.some(c => c.providerId === provider && c.type === 'oauth')) {
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
  const runtime = await emptyRuntime(root, endpoint);
  runtime.registerProvider(COMPATIBLE_PROVIDER, { ...compatibleProvider(endpoint), apiKey: `$${COMPATIBLE_KEY_ENV}` });
  return runtime;
}

/**
 * The same endpoint with a key the server already resolved from its own secret reference. The key is handed to Pi
 * as a runtime key, so it is used as given and never interpreted as a `$VAR` template or `!command`.
 */
export async function compatibleRuntimeWithKey(root: string, endpoint: CompatibleEndpoint, apiKey: string): Promise<ModelRuntime> {
  if (!apiKey) throw new Error('Compatible endpoint API key required');
  const runtime = await emptyRuntime(root, endpoint);
  runtime.registerProvider(COMPATIBLE_PROVIDER, compatibleProvider(endpoint));
  await runtime.setRuntimeApiKey(COMPATIBLE_PROVIDER, apiKey);
  return runtime;
}

async function emptyRuntime(root: string, endpoint: CompatibleEndpoint): Promise<ModelRuntime> {
  let url: URL;
  try { url = new URL(endpoint.baseUrl); } catch { throw new Error('Compatible endpoint must use https'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Compatible endpoint must use https');
  }
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
}

function compatibleProvider(endpoint: CompatibleEndpoint): Parameters<ModelRuntime['registerProvider']>[1] {
  return {
    name: 'OpenAI-compatible endpoint', baseUrl: endpoint.baseUrl, api: 'openai-completions',
    models: [{
      id: endpoint.model, name: endpoint.model, reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
      // Qwen-style chat templates: Pi's thinking level becomes chat_template_kwargs.enable_thinking (off → false).
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: 'max_tokens',
        thinkingFormat: 'qwen-chat-template' },
    }],
  };
}
