import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPiSession, PiConversation } from '../src/pi-session.ts';
import { probeRound, probeTool } from '../src/probe-round.ts';
import { fixtureRuntime, fixtureStream } from './support/fixture.ts';

async function setup(mode: 'text' | 'error' | 'wait' | 'tool' | 'forbidden' = 'text') {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-pi-test-'));
  const runtime = await fixtureRuntime();
  const session = await createPiSession(root, runtime);
  session.agent.streamFunction = fixtureStream(mode);
  return { root, session, conversation: new PiConversation(session), cleanup: async () => {
    await session.abort(); session.dispose(); await rm(root, { recursive: true, force: true });
  } };
}

test('Pi SDK persists assistant entries and restores the same session and context', async () => {
  const f = await setup();
  try {
    await f.conversation.send('Remember SYNTHETIC-ORCHID-731');
    const id = f.session.sessionId;
    const file = f.session.sessionFile!;
    const before = f.conversation.history();
    assert.equal(before.length, 2);
    f.session.dispose();
    const resumed = await createPiSession(f.root, await fixtureRuntime(), file);
    resumed.agent.streamFunction = fixtureStream('text');
    try {
      assert.equal(resumed.sessionId, id);
      const next = new PiConversation(resumed);
      assert.deepEqual(next.history(), before);
      await next.send('Repeat the previous token');
      assert.match(JSON.stringify(next.history().at(-1)), /SYNTHETIC-ORCHID-731/);
    } finally { resumed.dispose(); }
  } finally { await f.cleanup(); }
});

test('resume refuses a missing or corrupt session instead of starting another', async () => {
  const f = await setup();
  try {
    await assert.rejects(createPiSession(f.root, await fixtureRuntime(), join(f.root, 'missing.jsonl')), /session/);
    const file = join(f.root, 'bad.jsonl');
    await writeFile(file, '{not a session}\n');
    await assert.rejects(createPiSession(f.root, await fixtureRuntime(), file), /session/);
  } finally { await f.cleanup(); }
});

test('provider errors are not successful turns and private payloads are not exposed', async () => {
  const f = await setup('error');
  try { await assert.rejects(f.conversation.send('test'), { message: 'Pi response failed' }); }
  finally { await f.cleanup(); }
});

test('resume rejects valid header plus malformed message JSONL', async () => {
  const f = await setup();
  try {
    await f.conversation.send('Remember SYNTHETIC-ORCHID-731');
    const file = f.session.sessionFile!;
    const content = await readFile(file, 'utf8');
    await writeFile(file, content + '{"type":"message","message":\n');
    await assert.rejects(createPiSession(f.root, await fixtureRuntime(), file), /session/);
  } finally { await f.cleanup(); }
});

test('deadline aborts a hanging stream; overlapping sends are rejected', async () => {
  const f = await setup('wait');
  try {
    const first = f.conversation.send('test', 30);
    await assert.rejects(f.conversation.send('duplicate'), /busy/);
    await assert.rejects(first, /timeout/);
    assert.equal(f.session.isStreaming, false);
  } finally { await f.cleanup(); }
});

test('only the proposal tool is enabled and it cannot perform Calendar writes', async () => {
  const f = await setup('tool');
  try {
    assert.deepEqual(f.session.getActiveToolNames(), ['calendar_propose']);
    await f.conversation.send('Propose a fictional event');
    const tool = f.session.messages.find(m => m.role === 'toolResult');
    assert.equal(tool?.role === 'toolResult' && tool.isError, false);
    assert.match(JSON.stringify(tool), /pending-approval/);
  } finally { await f.cleanup(); }
});

test('a model cannot invoke an unregistered write tool', async () => {
  const f = await setup('forbidden');
  try {
    await f.conversation.send('Try a forbidden tool');
    const result = f.session.messages.find(m => m.role === 'toolResult');
    assert.equal(result?.role === 'toolResult' && result.isError, true);
  } finally { await f.cleanup(); }
});

test('the selected target is enforced: an unregistered model is refused, not substituted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-pi-test-'));
  try {
    await assert.rejects(createPiSession(root, await fixtureRuntime(), undefined, { provider: 'openai-codex', model: 'no-such-model' }),
      /unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restart round tolerates reply wording but requires the passphrase to be recalled from saved context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-pi-test-'));
  try {
    const first = await probeRound(root, await fixtureRuntime(), undefined, s => { s.agent.streamFunction = fixtureStream('ok'); });
    const second = await probeRound(root, await fixtureRuntime(), first.sessionFile, s => { s.agent.streamFunction = fixtureStream('text'); });
    assert.equal(second.sessionId, first.sessionId);
    assert.ok(second.entryIds.length > first.entryIds.length);
    await assert.rejects(probeRound(root, await fixtureRuntime(), first.sessionFile, s => { s.agent.streamFunction = fixtureStream('ok'); }),
      /context check failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live tool check classifies proposal, refusal of unregistered tools, and no call', async () => {
  const run = async (mode: 'tool' | 'forbidden' | 'ok') => {
    const root = await mkdtemp(join(tmpdir(), 'natsumi-pi-test-'));
    try { return await probeTool(root, await fixtureRuntime(), s => { s.agent.streamFunction = fixtureStream(mode); }); }
    finally { await rm(root, { recursive: true, force: true }); }
  };
  assert.equal(await run('tool'), 'proposal-pending-approval');
  assert.equal(await run('forbidden'), 'unregistered-tool-refused');
  assert.equal(await run('ok'), 'not-called');
});
