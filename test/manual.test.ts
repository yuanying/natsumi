import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { AGENT_LIST_PATH } from '../src/server/agent-requests.ts';
import { AGENT_LIST_DIRECTORY, AGENT_LIST_FILE } from '../src/server/agent-list.ts';
import { ASK_AGENT_DESCRIPTION, WORKSPACE_SECTION } from '../src/server/prompts.ts';

const root = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFile(`${root}${path}`, 'utf8');
/** The part of the manual the server writes on every start, rather than the image holding it (ADR 0036). */
const LIST = `/manual/agents/${AGENT_LIST_FILE}`;

const mentioned = (text: string) => [...text.matchAll(/\/manual\/[\w./-]*[\w]/g)].map(match => match[0]);

// ADR 0036: what she is pointed at must be there. A renamed page would leave her reading nothing.
test('every page of the manual that the prompt, the tool and the manual itself name exists', async () => {
  const pages = await readdir(`${root}manual`);
  const texts = [WORKSPACE_SECTION, ASK_AGENT_DESCRIPTION, AGENT_LIST_PATH, ...await Promise.all(pages.map(page => read(`manual/${page}`)))];
  const named = new Set(texts.flatMap(mentioned));
  assert.ok(named.has('/manual/INDEX.md'));
  assert.ok(named.has(LIST));
  for (const path of named) {
    if (path === LIST) continue;
    assert.ok(pages.includes(path.replace('/manual/', '')), `${path} is named but not in manual/`);
  }
  assert.equal(AGENT_LIST_PATH, LIST);
  // Every page is reachable from the index.
  const index = await read('manual/INDEX.md');
  for (const page of pages.filter(page => page !== 'INDEX.md')) assert.ok(index.includes(`/manual/${page}`), page);
});

test('the manual speaks of the same statuses and the same argument as the tool', async () => {
  const page = await read('manual/ask-agent.md');
  for (const word of ['completed', 'failed', 'input_required', 'gave_up', 'continue: true', 'continue: false', 'agent_reply']) {
    assert.ok(page.includes(word), word);
  }
});

test('the workspace image holds the manual, and compose shows it the list of agents read-only', async () => {
  const dockerfile = await read('Dockerfile');
  const workspace = dockerfile.slice(dockerfile.indexOf('AS workspace\n'), dockerfile.indexOf('\nFROM ', dockerfile.indexOf('AS workspace\n')));
  assert.match(workspace, /^COPY manual\/ \/manual\/$/m);
  const compose = await read('compose.yaml');
  const service = compose.slice(compose.indexOf('  natsumi-workspace:'), compose.indexOf('\nvolumes:'));
  const mount = service.match(/- type: volume\n\s+source: natsumi-data\n\s+target: \/manual\/agents\n([\s\S]*?)(?=\n\s+- type:|\n\s+# natsumi creates)/);
  assert.ok(mount, 'the list of agents is not mounted at /manual/agents');
  assert.match(mount[1]!, /read_only: true/);
  assert.match(mount[1]!, new RegExp(`subpath: ${AGENT_LIST_DIRECTORY}\\b`));
});
