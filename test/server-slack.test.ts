import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../src/server/server.ts';
import { FakeSlack, tsAt } from './support/fake-slack.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';
import { CLIENT_SECRET, serverConfig } from './support/server-fixture.ts';

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function launch(t: test.TestContext, slack: Record<string, unknown> | undefined) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-slack-')));
  const data = join(root, 'data');
  await mkdir(data);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ ...serverConfig(root), ...(slack ? { slack } : {}) }));
  const model = new ScriptedModel();
  model.auto = () => ({ text: '' });
  const fake = new FakeSlack();
  fake.addChannel({ id: 'C1', name: 'dev', isIm: false });
  const tokens: { botToken: string; appToken: string }[] = [];
  const logs: string[] = [];
  const server = await startServer({
    config, dataDir: data, cwd: '/', home: join(root, 'home'),
    env: { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET, SLACK_BOT: 'fixture-bot-token', SLACK_APP: 'fixture-app-token' },
    log: line => { logs.push(line); },
    pi: { runtime: fixtureRuntime, configureSession: session => { session.agent.streamFunction = model.streamFunction; } },
    slack: { connector: given => { tokens.push(given); return { api: fake, socket: fake }; } },
  });
  t.after(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, data, model, fake, tokens, logs, server };
}

test('with a slack section, each workspace connects with its own tokens and a mention reaches natsumi', async t => {
  const f = await launch(t, { workspaces: { work: { botTokenEnv: 'SLACK_BOT', appTokenEnv: 'SLACK_APP' } } });
  assert.deepEqual(f.tokens, [{ botToken: 'fixture-bot-token', appToken: 'fixture-app-token' }]);
  await until(() => f.fake.started === 1);
  f.fake.emit({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '<@UBOT> こんにちは', ts: tsAt('2026-09-25T05:32:05Z') });
  await until(() => f.model.contexts.some(context => JSON.stringify(context.messages).includes('slack_mention')));
  assert.match(await readFile(join(f.data, 'sources', 'slack', 'INDEX.md'), 'utf8'), /work\/#dev/);
  assert.ok(!f.logs.some(line => line.includes('fixture-bot-token') || line.includes('こんにちは')), 'no token or text in the log');
});

test('without a slack section nothing connects, and /sources is still made', async t => {
  const f = await launch(t, undefined);
  assert.deepEqual(f.tokens, []);
  assert.equal(f.fake.started, 0);
  assert.ok((await stat(join(f.data, 'sources'))).isDirectory());
});
