import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { COMPATIBLE_PROVIDER, type CompatibleEndpoint } from './compatible.ts';
import { isLoopbackHost } from './loopback.ts';

/** A runtime that uses only the OAuth login stored at `authPath` for `provider`. No API key route exists here. */
export async function subscriptionRuntime(root: string, authPath: string, provider: string): Promise<ModelRuntime> {
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
 * An explicitly chosen OpenAI-compatible Chat Completions endpoint (for example llama.cpp), with a key the server
 * already resolved from its own secret reference. The key is handed to Pi as a runtime key, so it is used as given
 * and never interpreted as a `$VAR` template or `!command`.
 */
export async function compatibleRuntimeWithKey(root: string, endpoint: CompatibleEndpoint, apiKey: string): Promise<ModelRuntime> {
  if (!apiKey) throw new Error('Compatible endpoint API key required');
  const runtime = await emptyRuntime(root, endpoint);
  runtime.registerProvider(COMPATIBLE_PROVIDER, compatibleProvider(endpoint));
  await runtime.setRuntimeApiKey(COMPATIBLE_PROVIDER, apiKey);
  return runtime;
}

/** Exported for the live harness's own variant, which reads the key from the environment instead. */
export async function emptyRuntime(root: string, endpoint: CompatibleEndpoint): Promise<ModelRuntime> {
  let url: URL;
  try { url = new URL(endpoint.baseUrl); } catch { throw new Error('Compatible endpoint must use https'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('Compatible endpoint must use https');
  }
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
}

/** Exported for the same reason as `emptyRuntime`: every route must describe the endpoint identically. */
export function compatibleProvider(endpoint: CompatibleEndpoint): Parameters<ModelRuntime['registerProvider']>[1] {
  return {
    name: 'OpenAI-compatible endpoint', baseUrl: endpoint.baseUrl, api: 'openai-completions',
    models: [{
      // Images too: a Slack mention's pictures ride beside its event, and `view` answers with one (ADR 0039). Pi sends
      // a tool result's image as a user message after it, which Chat Completions takes.
      id: endpoint.model, name: endpoint.model, reasoning: true, input: ['text', 'image'],
      // Pi caps a compaction summary at the smaller of this and its own summary budget (80% of a 16384-token reserve),
      // and thinking spends the same tokens. At 4096 a summary stopped at the cap and no compaction ever succeeded.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384,
      // Qwen-style chat templates: Pi's thinking level becomes chat_template_kwargs.enable_thinking (off → false).
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: 'max_tokens',
        thinkingFormat: 'qwen-chat-template' },
    }],
  };
}
