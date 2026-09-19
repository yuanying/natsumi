import { InMemoryCredentialStore, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { ModelRuntime, type AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../../src/pi/session.ts';

const { provider: PROVIDER, model: MODEL } = SUBSCRIPTION_TARGET;

export async function fixtureRuntime(): Promise<ModelRuntime> {
  // Synthetic in-memory OAuth shape. Every model stream is replaced below.
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000,
  }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  return runtime;
}

// text: recalls the token when it is in context; ok: fixed wording that never recalls it.
export function fixtureStream(mode: 'text' | 'ok' | 'error' | 'wait' | 'tool' | 'forbidden'): AgentSession['agent']['streamFunction'] {
  return (_model, context: Context, options) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: 'openai-codex-responses', provider: PROVIDER, model: MODEL,
      content: [], stopReason: 'stop', timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const fail = (reason: 'error' | 'aborted') => {
      message.stopReason = reason;
      message.errorMessage = 'synthetic private provider detail';
      stream.push({ type: 'error', reason, error: message });
    };
    if (mode === 'wait') {
      if (options?.signal?.aborted) fail('aborted');
      else options?.signal?.addEventListener('abort', () => fail('aborted'), { once: true });
      return stream;
    }
    if (mode === 'error') { fail('error'); return stream; }
    stream.push({ type: 'start', partial: message });
    if ((mode === 'tool' || mode === 'forbidden') && context.messages.at(-1)?.role !== 'toolResult') {
      const toolCall = { type: 'toolCall' as const, id: 'fixture-call', name: mode === 'tool' ? 'calendar_propose' : 'write', arguments: { title: 'Fictional event' } };
      message.content = [toolCall]; message.stopReason = 'toolUse';
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
      stream.push({ type: 'done', reason: 'toolUse', message });
    } else {
      // Continuation succeeds only if Pi supplies the saved token in model context.
      const text = mode !== 'ok' && JSON.stringify(context.messages).includes('SYNTHETIC-ORCHID-731') ? 'SYNTHETIC-ORCHID-731' : 'OK';
      message.content = [{ type: 'text', text: '' }];
      stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      message.content[0] = { type: 'text', text };
      stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
    }
    return stream;
  };
}
