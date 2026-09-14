import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyHistory, realtimeOutcome, requirePlus, realtimeErrorCategory } from '../src/probe-checks.ts';

test('history verification requires the original assistant response and completed turn', () => {
  const history = (status: string, type: string, text: string) => ({ thread: { id: 'thread-fixture', turns: [{ id: 'turn-fixture', status, items: [{ type, text }] }] } });
  assert.doesNotThrow(() => verifyHistory(history('completed', 'agentMessage', 'SYNTHETIC-123'), 'thread-fixture', 'turn-fixture', 'SYNTHETIC-123'));
  for (const invalid of [history('failed', 'agentMessage', 'SYNTHETIC-123'), history('completed', 'userMessage', 'SYNTHETIC-123'), history('completed', 'agentMessage', 'different'), { thread: { id: 'wrong', turns: [] } }]) {
    assert.throws(() => verifyHistory(invalid, 'thread-fixture', 'turn-fixture', 'SYNTHETIC-123'));
  }
});

test('only an explicit Plus ChatGPT account permits live model requests', () => {
  assert.doesNotThrow(() => requirePlus({ account: { type: 'chatgpt', planType: 'plus' } }));
  for (const account of [null, { type: 'apiKey' }, { type: 'chatgpt', planType: 'pro' }, { type: 'chatgpt', planType: 'unknown' }]) {
    assert.throws(() => requirePlus({ account }), /Plus/);
  }
});

test('realtime startup acceptance alone does not establish audio availability', () => {
  assert.equal(realtimeOutcome({ method: 'thread/realtime/started', params: {} }), 'pending');
  assert.equal(realtimeOutcome({ method: 'thread/realtime/closed', params: {} }), 'closed-without-audio');
  assert.equal(realtimeOutcome({ method: 'thread/realtime/error', params: { message: 'private detail' } }), 'realtime-error');
  assert.equal(realtimeOutcome({ method: 'thread/realtime/outputAudio/delta', params: { audio: { data: '' } } }), 'pending');
  assert.equal(realtimeOutcome({ method: 'thread/realtime/outputAudio/delta', params: { audio: { data: 'AAAA' } } }), 'audio-received');
});

test('realtime errors retain a useful category but never provider details', () => {
  assert.equal(realtimeErrorCategory({ method: 'thread/realtime/error', params: { message: 'HTTP 403 at https://private.example/token' } }), 'authentication-or-access');
  assert.equal(realtimeErrorCategory({ method: 'thread/realtime/error', params: { message: 'unknown private payload' } }), 'unclassified-upstream-error');
});
