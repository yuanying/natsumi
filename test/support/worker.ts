import { probeRound, probeTool } from '../../src/probe-round.ts';
import { fixtureRuntime, fixtureStream } from './fixture.ts';
// argv: root, route (ignored: always fixture), session file or '', operation.
try {
  const [root, , file, op] = process.argv.slice(2);
  const result = op === 'tool'
    ? await probeTool(root!, await fixtureRuntime(), session => { session.agent.streamFunction = fixtureStream('tool'); })
    : await probeRound(root!, await fixtureRuntime(), file || undefined, session => {
      session.agent.streamFunction = fixtureStream('text');
    });
  process.send?.(result);
} catch { process.exitCode = 1; }
finally { process.disconnect?.(); }
