import assert from 'node:assert/strict';
import test from 'node:test';
import { JEV_CASES, type JevCase } from '../src/probe/jev-cases.ts';
import { describeRun, evaluate, parseEvalArgs } from '../src/probe/jev-eval.ts';
import { JUDGE_ISSUES, JudgeError, type JudgeClient, type Judgement } from '../src/server/judge.ts';

/**
 * The evaluation of the dove's judge before thresholds are chosen (ADR 0040): the failures of the loop evaluation and
 * posts that should pass, all made up, judged once each; then how many would be stopped at each threshold.
 */

test('the cases are made up, cover every failure of the loop evaluation, and include posts that should pass', () => {
  const kinds = new Set(JEV_CASES.map(example => example.expect));
  assert.deepEqual([...kinds].sort(), ['pass', 'stop']);
  const categories = new Set(JEV_CASES.filter(example => example.expect === 'stop').map(example => example.category));
  for (const category of ['hinting', 'false-account', 'promise', 'fabricated-consent', 'private-matter', 'not-in-thread']) {
    assert.ok(categories.has(category), category);
  }
  assert.ok(JEV_CASES.filter(example => example.expect === 'pass').length >= 5);
  for (const example of JEV_CASES) {
    assert.equal(typeof example.state.draft, 'string');
    assert.ok(Array.isArray(example.state.conversation));
  }
});

class ScriptedJev implements JudgeClient {
  private readonly score: (draft: string) => number | Error;
  constructor(score: (draft: string) => number | Error) { this.score = score; }
  async judge(state: Record<string, unknown>): Promise<Judgement> {
    const score = this.score(String(state.draft));
    if (score instanceof Error) throw score;
    return { issues: JUDGE_ISSUES.map((issue, index) => ({ name: issue.name, label: issue.label, score: index === 0 ? score : 0 })) };
  }
}

test('each case is judged once, and the counts are given for every threshold, with the failures to judge apart', async () => {
  const state = (draft: string) => ({ channel: 'example/#team', reply_to: null, conversation: [], draft });
  const cases: JevCase[] = [
    { name: 'a', category: 'hinting', expect: 'stop', state: state('stop-high') },
    { name: 'b', category: 'promise', expect: 'stop', state: state('stop-low') },
    { name: 'c', category: 'ok', expect: 'pass', state: state('pass-mid') },
    { name: 'd', category: 'ok', expect: 'pass', state: state('broken') },
  ];
  const scores: Record<string, number | Error> = { 'stop-high': 0.9, 'stop-low': 0.2, 'pass-mid': 0.5, broken: new JudgeError('http-400') };
  const report = await evaluate(new ScriptedJev(draft => scores[draft]!), cases, [0.3, 0.6]);
  assert.deepEqual(report.cases.map(result => [result.name, result.max]), [['a', 0.9], ['b', 0.2], ['c', 0.5], ['d', null]]);
  assert.deepEqual(report.cases[3]!.error, 'http-400');
  assert.deepEqual(report.thresholds, [
    { owner: 0.3, stopped: 1, shouldStop: 2, wronglyStopped: 1, shouldPass: 1 },
    { owner: 0.6, stopped: 1, shouldStop: 2, wronglyStopped: 0, shouldPass: 1 },
  ]);
  assert.equal(report.noVerdict, 1);
});

test('the method, the endpoint and the model come from the environment, and the key only by the name of its variable', () => {
  assert.throws(() => parseEvalArgs([], {}), /JUDGE_BASE_URL/, 'the logprobs method needs somewhere to ask');
  assert.deepEqual(parseEvalArgs([], { JUDGE_BASE_URL: 'https://llm.example.test/v1', JUDGE_MODEL: 'fixture-model' }), {
    method: 'logprobs', baseUrl: 'https://llm.example.test/v1', model: 'fixture-model', concurrency: 4, timeoutSeconds: 30,
    thresholds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  });
  assert.throws(() => parseEvalArgs([], { JUDGE_BASE_URL: 'https://llm.example.test/v1' }), /JUDGE_MODEL/);
  assert.deepEqual(parseEvalArgs(['--thresholds', '0.25,0.5'], { JUDGE_METHOD: 'jev', JUDGE_API_KEY_ENV: 'MY_JEV_KEY', MY_JEV_KEY: 'k',
    JUDGE_CONCURRENCY: '2', JUDGE_TIMEOUT_SECONDS: '60' }), {
    method: 'jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKeyEnv: 'MY_JEV_KEY', apiKey: 'k', concurrency: 2, timeoutSeconds: 60,
    thresholds: [0.25, 0.5],
  });
  assert.throws(() => parseEvalArgs([], { JUDGE_METHOD: 'jev', JUDGE_API_KEY_ENV: 'MISSING_KEY' }), /MISSING_KEY/);
  assert.throws(() => parseEvalArgs([], { JUDGE_METHOD: 'guess' }), /JUDGE_METHOD/);
  assert.throws(() => parseEvalArgs(['--thresholds', '2'], { JUDGE_METHOD: 'jev' }), /thresholds/);
});

test('the report says how long each case took, and never the key', async () => {
  const state = { channel: 'example/#team', reply_to: null, conversation: [], draft: 'x' };
  const report = await evaluate(new ScriptedJev(() => 0.1), [{ name: 'a', category: 'ok', expect: 'pass', state }], [0.5]);
  assert.equal(typeof report.cases[0]!.ms, 'number');
  assert.equal(report.slowestMs, report.cases[0]!.ms);
  const shown = describeRun(parseEvalArgs([], { JUDGE_METHOD: 'jev', JUDGE_API_KEY_ENV: 'MY_JEV_KEY', MY_JEV_KEY: 'fixture-secret' }));
  assert.deepEqual(shown, { method: 'jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKeyEnv: 'MY_JEV_KEY', concurrency: 4, timeoutSeconds: 30 });
  assert.doesNotMatch(JSON.stringify(shown), /fixture-secret/);
});
