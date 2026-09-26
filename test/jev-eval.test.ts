import assert from 'node:assert/strict';
import test from 'node:test';
import { JEV_CASES, type JevCase } from '../src/probe/jev-cases.ts';
import { evaluate, parseEvalArgs } from '../src/probe/jev-eval.ts';
import { JEV_ISSUES, JevError, type JevClient, type JevJudgement } from '../src/server/jev.ts';

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

class ScriptedJev implements JevClient {
  private readonly score: (draft: string) => number | Error;
  constructor(score: (draft: string) => number | Error) { this.score = score; }
  async judge(state: Record<string, unknown>): Promise<JevJudgement> {
    const score = this.score(String(state.draft));
    if (score instanceof Error) throw score;
    return { issues: JEV_ISSUES.map((issue, index) => ({ name: issue.name, label: issue.label, score: index === 0 ? score : 0 })) };
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
  const scores: Record<string, number | Error> = { 'stop-high': 0.9, 'stop-low': 0.2, 'pass-mid': 0.5, broken: new JevError('http-400') };
  const report = await evaluate(new ScriptedJev(draft => scores[draft]!), cases, [0.3, 0.6]);
  assert.deepEqual(report.cases.map(result => [result.name, result.max]), [['a', 0.9], ['b', 0.2], ['c', 0.5], ['d', null]]);
  assert.deepEqual(report.cases[3]!.error, 'http-400');
  assert.deepEqual(report.thresholds, [
    { owner: 0.3, stopped: 1, shouldStop: 2, wronglyStopped: 1, shouldPass: 1 },
    { owner: 0.6, stopped: 1, shouldStop: 2, wronglyStopped: 0, shouldPass: 1 },
  ]);
  assert.equal(report.noVerdict, 1);
});

test('the endpoint, the model and the key come from the environment, and the key may be left out', () => {
  assert.deepEqual(parseEvalArgs([], {}), { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', thresholds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] });
  assert.deepEqual(parseEvalArgs(['--thresholds', '0.25,0.5'], { JEV_BASE_URL: 'http://127.0.0.1:8080', JEV_MODEL: 'local-judge', JEV_API_KEY: 'k' }),
    { baseUrl: 'http://127.0.0.1:8080', model: 'local-judge', apiKey: 'k', thresholds: [0.25, 0.5] });
  assert.throws(() => parseEvalArgs(['--thresholds', '2'], {}), /thresholds/);
});
