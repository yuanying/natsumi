import type { AssistantMessage, AssistantMessageEvent, Context } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../../src/pi-session.ts';

/** Carried by every failed reply. It must never reach a client. */
export const PRIVATE_DETAIL = 'synthetic private provider detail';

export interface ScriptedReply {
  context: Context;
  delta(text: string): void;
  finish(reason?: 'stop' | 'length' | 'error'): void;
}

/**
 * A synthetic model driven by the test: each model call waits until the test streams text and finishes it.
 * With `auto` set, every call replies at once with the returned text. An abort ends the reply as `aborted`.
 */
export class ScriptedModel {
  readonly contexts: Context[] = [];
  auto: ((context: Context) => string) | undefined;
  private readonly waiting: ((reply: ScriptedReply) => void)[] = [];
  private readonly pending: ScriptedReply[] = [];

  get calls(): number { return this.contexts.length; }

  /** The next model call, including one that already happened and was not taken yet. */
  next(): Promise<ScriptedReply> {
    const ready = this.pending.shift();
    return ready ? Promise.resolve(ready) : new Promise(resolve => this.waiting.push(resolve));
  }

  readonly streamFunction: AgentSession['agent']['streamFunction'] = (_model, context, options) => {
    this.contexts.push(structuredClone(context));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: 'openai-codex-responses', provider: SUBSCRIPTION_TARGET.provider,
      model: SUBSCRIPTION_TARGET.model, content: [{ type: 'text', text: '' }], stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    let text = '';
    let ended = false;
    const end = (event: AssistantMessageEvent) => { if (!ended) { ended = true; stream.push(event); } };
    const fail = (reason: 'error' | 'aborted') => {
      message.stopReason = reason;
      message.errorMessage = PRIVATE_DETAIL;
      end({ type: 'error', reason, error: message });
    };
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'text_start', contentIndex: 0, partial: message });
    const reply: ScriptedReply = {
      context,
      delta(chunk) {
        if (ended) return;
        text += chunk;
        message.content = [{ type: 'text', text }];
        stream.push({ type: 'text_delta', contentIndex: 0, delta: chunk, partial: message });
      },
      finish(reason = 'stop') {
        if (ended) return;
        if (reason === 'error') { fail('error'); return; }
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
        message.stopReason = reason;
        end({ type: 'done', reason, message });
      },
    };
    if (options?.signal?.aborted) fail('aborted');
    else options?.signal?.addEventListener('abort', () => fail('aborted'), { once: true });
    if (this.auto) {
      reply.delta(this.auto(context));
      reply.finish('stop');
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter(reply); else this.pending.push(reply);
    return stream;
  };
}
