import { pathToFileURL } from 'node:url';
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL, HttpJevClient } from '../server/jev.ts';
import { DEFAULT_JUDGE_TIMEOUT_MS, JudgeError, type JudgeClient } from '../server/judge.ts';
import { DEFAULT_JUDGE_CONCURRENCY, LogprobJudgeClient } from '../server/logprob-judge.ts';
import { JEV_CASES, type JevCase } from './jev-cases.ts';

/**
 * Evaluates the dove's judge before its thresholds are set (ADR 0040): every made-up case in `jev-cases.ts` is judged
 * once, and for each threshold the report counts the drafts that should be stopped and were, and those that should
 * pass and were stopped. A draft counts as stopped at a threshold when any issue scores at or over it, which is where
 * the server would hand it to the owner or turn it back. Each case's time is given, to set the judgement's time limit.
 *
 *   JUDGE_BASE_URL=https://llm.example.net/v1 JUDGE_MODEL=my-model JUDGE_API_KEY_ENV=MY_KEY npm run probe:jev -- --thresholds 0.5,0.9
 *
 * The environment names the method (`JUDGE_METHOD`: logprobs by default, or jev), the endpoint (`JUDGE_BASE_URL`,
 * required for logprobs, TypeSafe's by default for jev), the model (`JUDGE_MODEL`, required for logprobs), the questions
 * asked at once (`JUDGE_CONCURRENCY`) and the time limit (`JUDGE_TIMEOUT_SECONDS`). The key is given by the name of the
 * variable that holds it (`JUDGE_API_KEY_ENV`), so its value is never typed on a command line nor printed. It calls the
 * real endpoint, so the tests never run it; they run `evaluate`.
 */

export interface EvalArgs {
  method: 'logprobs' | 'jev'; baseUrl: string; model: string; apiKeyEnv?: string; apiKey?: string;
  concurrency: number; timeoutSeconds: number; thresholds: number[];
}

export function parseEvalArgs(argv: string[], env: Record<string, string | undefined>): EvalArgs {
  let thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--thresholds') {
      thresholds = (argv[index + 1] ?? '').split(',').map(Number);
      index += 1;
    }
  }
  if (thresholds.length === 0 || !thresholds.every(value => Number.isFinite(value) && value > 0 && value <= 1)) {
    throw new Error('--thresholds takes numbers over 0 and at most 1, separated by commas');
  }
  const method = env.JUDGE_METHOD || 'logprobs';
  if (method !== 'logprobs' && method !== 'jev') throw new Error('JUDGE_METHOD is logprobs or jev');
  const baseUrl = env.JUDGE_BASE_URL || (method === 'jev' ? DEFAULT_JEV_BASE_URL : undefined);
  if (!baseUrl) throw new Error('JUDGE_BASE_URL is required for the logprobs method');
  const model = env.JUDGE_MODEL || (method === 'jev' ? DEFAULT_JEV_MODEL : undefined);
  if (!model) throw new Error('JUDGE_MODEL is required for the logprobs method');
  const apiKeyEnv = env.JUDGE_API_KEY_ENV || undefined;
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !apiKey) throw new Error(`${apiKeyEnv} (named by JUDGE_API_KEY_ENV) is empty`);
  const concurrency = Number(env.JUDGE_CONCURRENCY || DEFAULT_JUDGE_CONCURRENCY);
  const timeoutSeconds = Number(env.JUDGE_TIMEOUT_SECONDS || DEFAULT_JUDGE_TIMEOUT_MS / 1000);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('JUDGE_CONCURRENCY is a positive integer');
  if (!(timeoutSeconds > 0)) throw new Error('JUDGE_TIMEOUT_SECONDS is a positive number');
  return { method, baseUrl, model, ...(apiKeyEnv ? { apiKeyEnv, apiKey } : {}), concurrency, timeoutSeconds, thresholds };
}

/** What the run is against, as the report says it: everything but the key's value. */
export function describeRun(args: EvalArgs): Record<string, unknown> {
  const { apiKey: _key, thresholds: _thresholds, ...shown } = args;
  return shown;
}

export interface EvalReport {
  cases: { name: string; category: string; expect: JevCase['expect']; max: number | null; ms: number; scores?: Record<string, number>; error?: string }[];
  /** The longest a case took: what the judgement's time limit has to allow. */
  slowestMs: number;
  thresholds: { owner: number; stopped: number; shouldStop: number; wronglyStopped: number; shouldPass: number }[];
  /** Cases with no verdict: left out of the counts above. */
  noVerdict: number;
}

export async function evaluate(client: JudgeClient, cases: readonly JevCase[], thresholds: number[]): Promise<EvalReport> {
  const results: EvalReport['cases'] = [];
  for (const example of cases) {
    const started = Date.now();
    try {
      const judged = await client.judge(example.state, { placement: example.state.reply_to !== null && example.state.reply_to !== undefined });
      const scores = Object.fromEntries(judged.issues.map(issue => [issue.name, issue.score]));
      results.push({ name: example.name, category: example.category, expect: example.expect, max: Math.max(...judged.issues.map(issue => issue.score)),
        ms: Date.now() - started, scores });
    } catch (error) {
      results.push({ name: example.name, category: example.category, expect: example.expect, max: null, ms: Date.now() - started,
        error: error instanceof JudgeError ? error.kind : 'error' });
    }
  }
  const judged = results.filter(result => result.max !== null);
  return {
    cases: results,
    slowestMs: Math.max(0, ...results.map(result => result.ms)),
    thresholds: thresholds.map(owner => ({
      owner,
      stopped: judged.filter(result => result.expect === 'stop' && result.max! >= owner).length,
      shouldStop: judged.filter(result => result.expect === 'stop').length,
      wronglyStopped: judged.filter(result => result.expect === 'pass' && result.max! >= owner).length,
      shouldPass: judged.filter(result => result.expect === 'pass').length,
    })),
    noVerdict: results.length - judged.length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseEvalArgs(process.argv.slice(2), process.env);
  const common = { baseUrl: args.baseUrl, model: args.model, timeoutMs: args.timeoutSeconds * 1000, ...(args.apiKey ? { apiKey: args.apiKey } : {}) };
  const client = args.method === 'jev' ? new HttpJevClient(common) : new LogprobJudgeClient({ ...common, concurrency: args.concurrency });
  const report = await evaluate(client, JEV_CASES, args.thresholds);
  // The cases are made up, so the report may carry their names and scores; never the key.
  process.stdout.write(`${JSON.stringify({ ...describeRun(args), ...report }, null, 2)}\n`);
}
