import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCode } from '@slack/web-api';
import { callError, describeFailure, SlackCallError, toSlackMessage } from '../src/server/slack-api.ts';

/** How a failure of Slack's Web API reads in the log: the call, and Slack's own code, never what was asked for. */

test('Slack\'s refusal keeps its code and the scope it lacked', () => {
  const refused = Object.assign(new Error('An API error occurred: missing_scope'), {
    code: ErrorCode.PlatformError, data: { ok: false, error: 'missing_scope', needed: 'im:history', provided: 'channels:history' },
  });
  const error = callError('conversations.history', refused);
  assert.ok(error instanceof SlackCallError);
  assert.equal(describeFailure(error), 'conversations.history: missing_scope, needed im:history');
});

test('an HTTP error, a rate limit and a request that never arrived each say what they were', () => {
  const http = Object.assign(new Error('x'), { code: ErrorCode.HTTPError, statusCode: 503 });
  assert.equal(describeFailure(callError('users.info', http)), 'users.info: http_503');
  const limited = Object.assign(new Error('x'), { code: ErrorCode.RateLimitedError, retryAfter: 30 });
  assert.equal(describeFailure(callError('conversations.replies', limited)), 'conversations.replies: ratelimited');
  const request = Object.assign(new Error('x'), { code: ErrorCode.RequestError, original: Object.assign(new Error('y'), { code: 'ECONNRESET' }) });
  assert.equal(describeFailure(callError('users.conversations', request)), 'users.conversations: ECONNRESET');
});

test('a code that is not a plain word is not copied into the log', () => {
  const odd = Object.assign(new Error('x'), { code: ErrorCode.PlatformError, data: { ok: false, error: 'hello <@U123> xoxb-secret words' } });
  assert.equal(describeFailure(callError('conversations.history', odd)), 'conversations.history: unknown');
});

test('a failure that is not Slack\'s is named by its kind, and its code when it has one', () => {
  assert.equal(describeFailure(Object.assign(new Error('EACCES: /data/secret'), { code: 'EACCES' })), 'Error: EACCES');
  assert.equal(describeFailure(new TypeError('something with text')), 'TypeError');
  assert.equal(describeFailure('a string'), 'error');
});

test('a message\'s reactions are read with who put them on, and a message without the field has none said', () => {
  const message = toSlackMessage({ ts: '1.000100', user: 'U1', text: 'x', reactions: [
    { name: '+1', users: ['U1', 'U2'], count: 5 }, { name: 'tada', count: 1 }, { users: ['U1'], count: 1 }] });
  assert.deepEqual(message.reactions, [{ name: '+1', users: ['U1', 'U2'], count: 5 }, { name: 'tada', users: [], count: 1 }]);
  assert.equal(toSlackMessage({ ts: '1.000100', user: 'U1', text: 'x' }).reactions, undefined);
});
