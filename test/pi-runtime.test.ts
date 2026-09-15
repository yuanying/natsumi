import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { COMPATIBLE_PROVIDER } from '../src/pi-auth.ts';
import { openPiSession } from '../src/pi-session.ts';
import type { PiConfig } from '../src/server/config.ts';
import { createModelRuntime, PiUnavailableError } from '../src/server/pi-runtime.ts';

// `$HOME` and a leading `!` would be expanded or executed if the key were treated as a Pi config template.
const KEY = '!fixture-$HOME-key';

/** A local stand-in for an OpenAI-compatible Chat Completions endpoint that records the Authorization header and body. */
async function startEndpoint() {
  const authorizations: (string | undefined)[] = [];
  const bodies: Record<string, any>[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      authorizations.push(request.headers.authorization);
      try { bodies.push(JSON.parse(body) as Record<string, any>); } catch { bodies.push({}); }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.write(chunk({ role: 'assistant', content: 'OK' }, null));
      response.write(chunk({}, 'stop'));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    authorizations, bodies,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-pi-runtime-')));
  const paths = { cwd: join(root, 'data'), agentDir: join(root, 'pi', 'agent'), sessionDir: join(root, 'pi', 'sessions') };
  for (const dir of Object.values(paths)) await mkdir(dir, { recursive: true });
  const config = (overrides: Partial<PiConfig>): PiConfig => ({
    agentDirectory: paths.agentDir, sessionDirectory: paths.sessionDir, authPath: join(paths.agentDir, 'auth.json'),
    model: { provider: 'openai-codex', id: 'gpt-5.5' }, thinking: 'on', voiceEnabled: false, ...overrides,
  });
  return { root, paths, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('an OpenAI-compatible endpoint receives exactly the referenced key, from an environment variable or a secret file', async () => {
  const endpoint = await startEndpoint();
  const f = await setup();
  try {
    const keyFile = join(f.root, 'pi-api-key');
    await writeFile(keyFile, `${KEY}\n`, { mode: 0o600 });
    for (const apiKey of [{ env: 'FIXTURE_PI_API_KEY' }, { file: keyFile }]) {
      const pi = f.config({ model: { provider: COMPATIBLE_PROVIDER, id: 'fixture-model' }, compatible: { baseUrl: endpoint.baseUrl, apiKey } });
      const { runtime, target } = await createModelRuntime(pi, { FIXTURE_PI_API_KEY: KEY });
      assert.deepEqual(target, { provider: COMPATIBLE_PROVIDER, model: 'fixture-model' });
      const session = await openPiSession({ ...f.paths, modelRuntime: runtime, target, systemPrompt: 'fixture', thinkingLevel: 'off' });
      try {
        await session.prompt('hello', { expandPromptTemplates: false });
        const reply = session.messages.at(-1);
        assert.equal(reply?.role === 'assistant' ? reply.stopReason : undefined, 'stop');
      } finally { session.dispose(); }
    }
    assert.deepEqual(endpoint.authorizations, [`Bearer ${KEY}`, `Bearer ${KEY}`]);
  } finally { await f.cleanup(); await endpoint.close(); }
});

test('thinking is requested from a compatible endpoint only when it is switched on', async () => {
  const endpoint = await startEndpoint();
  const f = await setup();
  try {
    const pi = f.config({ model: { provider: COMPATIBLE_PROVIDER, id: 'fixture-model' },
      compatible: { baseUrl: endpoint.baseUrl, apiKey: { env: 'FIXTURE_PI_API_KEY' } } });
    const { runtime, target } = await createModelRuntime(pi, { FIXTURE_PI_API_KEY: KEY });
    for (const thinkingLevel of ['medium', 'off'] as const) {
      const session = await openPiSession({ ...f.paths, modelRuntime: runtime, target, systemPrompt: 'fixture', thinkingLevel });
      try { await session.prompt('hello', { expandPromptTemplates: false }); } finally { session.dispose(); }
    }
    assert.deepEqual(endpoint.bodies.map(body => body.chat_template_kwargs?.enable_thinking), [true, false]);
  } finally { await f.cleanup(); await endpoint.close(); }
});

test('a missing key or login stops before any request, with no fallback to another route', async () => {
  const endpoint = await startEndpoint();
  const f = await setup();
  try {
    const compatible = (apiKey: { env: string } | { file: string }) =>
      f.config({ model: { provider: COMPATIBLE_PROVIDER, id: 'fixture-model' }, compatible: { baseUrl: endpoint.baseUrl, apiKey } });
    const refused = (pi: PiConfig, env: Record<string, string | undefined> = {}) =>
      assert.rejects(createModelRuntime(pi, env), (error: unknown) => {
        assert.ok(error instanceof PiUnavailableError, String(error));
        assert.equal(error.message.includes(f.root), false);
        return true;
      });
    await refused(compatible({ env: 'FIXTURE_PI_API_KEY' }));
    await refused(compatible({ file: join(f.root, 'missing-key') }));
    // The subscription route needs its own OAuth login; an API key in the environment is never used instead.
    await refused(f.config({}), { FIXTURE_PI_API_KEY: KEY, OPENAI_API_KEY: KEY });
    await writeFile(join(f.paths.agentDir, 'auth.json'), '{}', { mode: 0o600 });
    await refused(f.config({}), { OPENAI_API_KEY: KEY });
    assert.deepEqual(endpoint.authorizations, []);
  } finally { await f.cleanup(); await endpoint.close(); }
});
