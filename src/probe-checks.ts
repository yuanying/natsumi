import { record, type Notification } from './rpc.ts';

export function requirePlus(value: unknown): void {
  const account = record(value).account;
  if (!account || record(account).type !== 'chatgpt' || record(account).planType !== 'plus') {
    throw new Error('An existing ChatGPT Plus account is required; no API fallback');
  }
}

export function verifyHistory(value: unknown, threadId: string, turnId: string, marker: string): void {
  const thread = record(record(value).thread);
  if (thread.id !== threadId || !Array.isArray(thread.turns)) throw new Error('History identity mismatch');
  const turn = thread.turns.map(record).find(t => t.id === turnId);
  if (!turn || turn.status !== 'completed' || !Array.isArray(turn.items) ||
      !turn.items.map(record).some(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text.includes(marker))) {
    throw new Error('Expected completed synthetic assistant response missing');
  }
}

export function realtimeOutcome(event: Notification): string {
  if (event.method === 'thread/realtime/error') return 'realtime-error';
  if (event.method === 'thread/realtime/closed') return 'closed-without-audio';
  if (event.method === 'thread/realtime/outputAudio/delta') {
    const audio = record(record(event.params).audio);
    if (typeof audio.data === 'string' && audio.data.length > 0) return 'audio-received';
  }
  return 'pending';
}

/** Allowlisted categories only: upstream messages may contain private URLs. */
export function realtimeErrorCategory(event: Notification): string {
  const message = String(record(event.params).message ?? '');
  if (/401|403|unauthori[sz]ed|forbidden|authentication/i.test(message)) return 'authentication-or-access';
  if (/429|rate.limit|quota/i.test(message)) return 'rate-or-quota';
  if (/not.supported|unsupported|not.available|not.enabled/i.test(message)) return 'unsupported-or-disabled';
  if (/400|invalid|missing|required|not.found|404/i.test(message)) return 'invalid-request-or-missing-resource';
  if (/500|502|503|internal|service.unavailable/i.test(message)) return 'upstream-service';
  if (/timed.out|timeout/i.test(message)) return 'timeout';
  if (/connect|websocket|socket|dns|tls|handshake|http/i.test(message)) return 'upstream-connection';
  return 'unclassified-upstream-error';
}

export function realtimeErrorSignals(event: Notification): string[] {
  const message = String(record(event.params).message ?? '').toLowerCase();
  return ['model', 'voice', 'audio', 'text', 'session', 'version', 'transport', 'prompt', 'permission',
    'expired', 'disabled', 'invalid', 'unexpected', 'closed', 'stream', 'decode', 'parse', 'deserialize',
    'eof', '400', '401', '403', '404', '429', '500', '502', '503'].filter(word => message.includes(word));
}
