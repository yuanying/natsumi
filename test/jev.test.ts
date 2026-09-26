import assert from 'node:assert/strict';
import test from 'node:test';
import { decideVerdict, HttpJevClient, JEV_ISSUES, JevError, JEV_URL, type JevJudgement } from '../src/server/jev.ts';

/**
 * The dove's judge (ADR 0039, ADR 0040): one call to Jev with a Noul per issue and a Choice for where a reply goes,
 * asked in English over the draft and what surrounds it in Slack. The server turns the scores into a verdict.
 */

const STATE = { channel: 'work/#dev', reply_to: { from: '山田', at: '2026-09-25 14:32:05', text: '明日のレビュー大丈夫？' },
  conversation: [{ from: '山田', at: '2026-09-25 14:32:05', text: '明日のレビュー大丈夫？' }], draft: '大丈夫です。' };

function answering(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: fetchStub as typeof fetch };
}

const fullAnswer = () => ({
  model: 'jev-1.13.0',
  answers: {
    ...Object.fromEntries(JEV_ISSUES.map((issue, index) => [issue.name, { type: 'noul', noul: index === 1 ? 0.9 : 0.05 }])),
    placement: { type: 'choice', choice: 'thread', probabilities: { thread: 0.8, channel: 0.2 }, confidence: 0.7 },
  },
  usage: { input_tokens: 321, output_tokens: 0 },
});

test('one call asks every issue as a Noul and the placement as a Choice, in English, with the key as a bearer token', async () => {
  const stub = answering(200, fullAnswer());
  const client = new HttpJevClient({ apiKey: 'fixture-jev-key', model: 'jev-latest', fetch: stub.fetch });
  await client.judge(STATE, { placement: true });
  assert.equal(stub.calls.length, 1);
  const { url, init } = stub.calls[0]!;
  assert.equal(url, JEV_URL);
  assert.equal(init.method, 'POST');
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer fixture-jev-key');
  const body = JSON.parse(String(init.body));
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, STATE);
  for (const issue of JEV_ISSUES) {
    assert.equal(body.questions[issue.name].type, 'noul');
    assert.doesNotMatch(body.questions[issue.name].instructions, /[぀-ヿ一-鿿]/, `${issue.name} is asked in English`);
  }
  assert.equal(body.questions.placement.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.placement.criteria).sort(), ['channel', 'thread']);
});

test('the answer becomes a score per issue, with its Japanese label, and the placement', async () => {
  const client = new HttpJevClient({ apiKey: 'k', model: 'jev-latest', fetch: answering(200, fullAnswer()).fetch });
  const judged = await client.judge(STATE, { placement: true });
  assert.equal(judged.issues.length, JEV_ISSUES.length);
  assert.deepEqual(judged.issues[1], { name: JEV_ISSUES[1]!.name, label: JEV_ISSUES[1]!.label, score: 0.9 });
  assert.deepEqual(judged.placement, { choice: 'thread', probabilities: { thread: 0.8, channel: 0.2 } });
});

test('without a message to reply to, the placement is not asked', async () => {
  const stub = answering(200, { ...fullAnswer(), answers: Object.fromEntries(JEV_ISSUES.map(issue => [issue.name, { type: 'noul', noul: 0.1 }])) });
  const client = new HttpJevClient({ apiKey: 'k', model: 'jev-latest', fetch: stub.fetch });
  const judged = await client.judge({ ...STATE, reply_to: null }, { placement: false });
  assert.equal(JSON.parse(String(stub.calls[0]!.init.body)).questions.placement, undefined);
  assert.equal(judged.placement, undefined);
});

for (const [name, status, body, kind] of [
  ['a refused key', 401, { error: 'x' }, 'http-401'],
  ['a rate limit', 429, { error: 'x' }, 'http-429'],
  ['an overload', 529, { error: 'x' }, 'http-529'],
  ['a body that is not JSON', 200, 'not json', 'malformed'],
  ['an answer missing an issue', 200, { answers: { placement: { choice: 'thread', probabilities: { thread: 1, channel: 0 } } } }, 'malformed'],
  ['a score out of range', 200, { answers: Object.fromEntries(JEV_ISSUES.map(issue => [issue.name, { noul: 2 }])) }, 'malformed'],
] as const) {
  test(`${name} is no verdict, and the error names only its kind`, async () => {
    const client = new HttpJevClient({ apiKey: 'fixture-jev-key', model: 'jev-latest', fetch: answering(status, body).fetch });
    await assert.rejects(client.judge(STATE, { placement: false }), (error: unknown) => {
      assert.ok(error instanceof JevError);
      assert.equal(error.kind, kind);
      assert.doesNotMatch(error.message, /fixture-jev-key|大丈夫/);
      return true;
    });
  });
}

test('a call that never answers is cut off and is no verdict', async () => {
  const never = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;
  const client = new HttpJevClient({ apiKey: 'k', model: 'jev-latest', fetch: never, timeoutMs: 20 });
  await assert.rejects(client.judge(STATE, { placement: false }), (error: unknown) => error instanceof JevError && error.kind === 'timeout');
});

const judged = (scores: number[]): JevJudgement => ({
  issues: JEV_ISSUES.map((issue, index) => ({ name: issue.name, label: issue.label, score: scores[index] ?? 0 })),
});

test('the verdict: send under the owner threshold, the owner between, returned at or over the return threshold', () => {
  const thresholds = { owner: 0.3, return: 0.7 };
  assert.equal(decideVerdict(judged([0.1, 0.29]), thresholds).verdict, 'send');
  const owner = decideVerdict(judged([0.1, 0.3]), thresholds);
  assert.equal(owner.verdict, 'owner');
  assert.deepEqual(owner.issues.filter(issue => issue.flagged).map(issue => issue.name), [JEV_ISSUES[1]!.name]);
  const returned = decideVerdict(judged([0.7, 0.4]), thresholds);
  assert.equal(returned.verdict, 'return');
  assert.deepEqual(returned.issues.filter(issue => issue.flagged).map(issue => issue.name), [JEV_ISSUES[0]!.name, JEV_ISSUES[1]!.name]);
  assert.equal(returned.issues[2]!.flagged, undefined, 'an issue under the threshold carries no flag');
});
