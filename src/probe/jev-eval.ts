import { pathToFileURL } from 'node:url';
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL, HttpJevClient, JevError, type JevClient } from '../server/jev.ts';
import { JEV_CASES, type JevCase } from './jev-cases.ts';

/**
 * Evaluates the dove's judge before its thresholds are set (ADR 0040): every made-up case in `jev-cases.ts` is judged
 * once, and for each threshold the report counts the drafts that should be stopped and were, and those that should
 * pass and were stopped. A draft counts as stopped at a threshold when any issue scores at or over it, which is where
 * the server would hand it to the owner or turn it back.
 *
 *   JEV_BASE_URL=http://127.0.0.1:8080 JEV_MODEL=local-judge npm run probe:jev -- --thresholds 0.3,0.5,0.7
 *
 * `JEV_BASE_URL` (default TypeSafe's), `JEV_MODEL` (default jev-latest) and `JEV_API_KEY` (left out for a server that
 * needs none) come from the environment. It calls the real endpoint, so the tests never run it; they run `evaluate`.
 */

export interface EvalArgs { baseUrl: string; model: string; apiKey?: string; thresholds: number[] }

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
  return { baseUrl: env.JEV_BASE_URL || DEFAULT_JEV_BASE_URL, model: env.JEV_MODEL || DEFAULT_JEV_MODEL,
    ...(env.JEV_API_KEY ? { apiKey: env.JEV_API_KEY } : {}), thresholds };
}

export interface EvalReport {
  cases: { name: string; category: string; expect: JevCase['expect']; max: number | null; scores?: Record<string, number>; error?: string }[];
  thresholds: { owner: number; stopped: number; shouldStop: number; wronglyStopped: number; shouldPass: number }[];
  /** Cases with no verdict: left out of the counts above. */
  noVerdict: number;
}

export async function evaluate(client: JevClient, cases: readonly JevCase[], thresholds: number[]): Promise<EvalReport> {
  const results: EvalReport['cases'] = [];
  for (const example of cases) {
    try {
      const judged = await client.judge(example.state, { placement: example.state.reply_to !== null && example.state.reply_to !== undefined });
      const scores = Object.fromEntries(judged.issues.map(issue => [issue.name, issue.score]));
      results.push({ name: example.name, category: example.category, expect: example.expect, max: Math.max(...judged.issues.map(issue => issue.score)), scores });
    } catch (error) {
      results.push({ name: example.name, category: example.category, expect: example.expect, max: null,
        error: error instanceof JevError ? error.kind : 'error' });
    }
  }
  const judged = results.filter(result => result.max !== null);
  return {
    cases: results,
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
  const client = new HttpJevClient({ baseUrl: args.baseUrl, model: args.model, ...(args.apiKey ? { apiKey: args.apiKey } : {}) });
  const report = await evaluate(client, JEV_CASES, args.thresholds);
  // The cases are made up, so the report may carry their names and scores; never the key.
  process.stdout.write(`${JSON.stringify({ baseUrl: args.baseUrl, model: args.model, ...report }, null, 2)}\n`);
}
