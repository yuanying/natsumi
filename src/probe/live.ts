import { access } from 'node:fs/promises';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { parseProbeArgs } from './args.ts';
import { exerciseRestart, exerciseTool } from './process.ts';

const NOT_RUN = new Set(['missing-route', 'missing-auth', 'missing-key']);
const report = { pi: VERSION, route: 'none', text: 'not-run', tool: 'not-run', voice: 'disabled-not-tested' };
try {
  let route;
  try { route = parseProbeArgs(process.argv.slice(2), process.env); } catch (error) {
    throw new Error(error instanceof Error && NOT_RUN.has(error.message) ? error.message : 'missing-route');
  }
  report.route = route.kind;
  if (route.kind === 'subscription') {
    try { await access(route.authPath); } catch { throw new Error('missing-auth'); }
  }
  if (VERSION !== '0.87.1') throw new Error('unsupported-version');
  const worker = new URL('./worker.ts', import.meta.url);
  const json = JSON.stringify(route); // Contains no key: compatible keys stay in the environment.
  await exerciseRestart(worker, json);
  report.text = 'create-send-history-process-restart-resume-context-passed';
  report.tool = await exerciseTool(worker, json);
  if (report.tool === 'not-called') process.exitCode = 1;
} catch (error) {
  const reason = error instanceof Error ? error.message : '';
  if (NOT_RUN.has(reason)) { report.text = `not-run-${reason}`; process.exitCode = 2; }
  else { if (report.text === 'not-run') report.text = 'failed'; else report.tool = 'failed'; process.exitCode = 1; }
}
// Fixed outcomes only. No keys, URLs, paths, IDs, conversation text, or provider payloads.
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
