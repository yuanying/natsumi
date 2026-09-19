import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { COMPATIBLE_PROVIDER, compatibleRuntimeWithKey } from '../src/pi/auth.ts';
import { ConfigError, parseConfig } from '../src/server/config.ts';

// One rule decides which plaintext endpoints are allowed, so a baseUrl the config accepts is one the runtime can open.
const LOOPBACK = ['http://127.0.0.2:8080/v1', 'http://[::1]:8080/v1'];
const REMOTE = ['http://10.0.0.1/v1', 'http://llm.example.invalid/v1'];

const pi = () => ({
  agentDirectory: '/srv/natsumi-pi/agent',
  sessionDirectory: '/srv/natsumi-pi/sessions',
  authPath: '/srv/natsumi-pi/agent/auth.json',
  model: { provider: COMPATIBLE_PROVIDER, id: 'fixture-model' },
  voiceEnabled: false,
});
const base = (baseUrl: string) => ({
  pi: { ...pi(), compatible: { baseUrl, apiKeyEnv: 'NATSUMI_PI_API_KEY' } },
  publicOrigin: 'https://natsumi.example.test',
  listen: { host: '::', port: 8443, tls: { certFile: '/run/secrets/natsumi-tls-cert', keyFile: '/run/secrets/natsumi-tls-key' } },
  github: {
    clientId: 'Iv1.fixtureclient',
    clientSecretEnv: 'NATSUMI_GITHUB_CLIENT_SECRET',
    callbackUrl: 'https://natsumi.example.test/auth/github/callback',
    allowedUserId: 4242001,
  },
});

async function inTemporaryRoot(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-loopback-'));
  try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('a plaintext loopback endpoint the config accepts is one the runtime opens', async () => {
  for (const baseUrl of LOOPBACK) {
    assert.equal(parseConfig(base(baseUrl)).pi.compatible?.baseUrl, baseUrl);
    await inTemporaryRoot(async root => {
      const runtime = await compatibleRuntimeWithKey(root, { baseUrl, model: 'fixture-model' }, 'fixture-key');
      assert.ok(runtime.getModel(COMPATIBLE_PROVIDER, 'fixture-model'));
    });
  }
});

test('a plaintext endpoint off loopback is refused by the config and by the runtime alike', async () => {
  for (const baseUrl of REMOTE) {
    assert.throws(() => parseConfig(base(baseUrl)), (error: unknown) => {
      assert.ok(error instanceof ConfigError, String(error));
      assert.equal(error.path, 'pi.compatible.baseUrl');
      assert.match(error.message, /https/);
      return true;
    });
    await inTemporaryRoot(async root => {
      await assert.rejects(compatibleRuntimeWithKey(root, { baseUrl, model: 'fixture-model' }, 'fixture-key'), /https/);
    });
  }
});
