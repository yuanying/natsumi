import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigError, envReference, loadConfig, parseConfig } from '../src/server/config.ts';

const pi = () => ({
  agentDirectory: '/srv/natsumi-pi/agent',
  sessionDirectory: '/srv/natsumi-pi/sessions',
  authPath: '/srv/natsumi-pi/agent/auth.json',
  model: { provider: 'openai-codex', id: 'gpt-5.5' },
  voiceEnabled: false,
});

function rejects(raw: unknown, path: string, reason?: RegExp) {
  assert.throws(() => parseConfig(raw), (error: unknown) => {
    assert.ok(error instanceof ConfigError, String(error));
    assert.equal(error.path, path);
    if (reason) assert.match(error.message, reason);
    return true;
  });
}

test('a valid config becomes a typed server config', () => {
  assert.deepEqual(parseConfig({ pi: pi() }), { pi: pi() });
});

test('the shipped example config is valid', async () => {
  const config = await loadConfig(new URL('../config.example.json', import.meta.url).pathname);
  assert.equal(config.pi.voiceEnabled, false);
});

test('invalid values name the offending setting', () => {
  rejects(null, 'config', /object/);
  rejects({}, 'pi', /required/);
  rejects({ pi: { ...pi(), agentDirectory: 'relative/agent' } }, 'pi.agentDirectory', /absolute/);
  rejects({ pi: { ...pi(), sessionDirectory: '' } }, 'pi.sessionDirectory');
  rejects({ pi: { ...pi(), authPath: 42 } }, 'pi.authPath');
  rejects({ pi: { ...pi(), model: { provider: 'openai-codex' } } }, 'pi.model.id', /required/);
  rejects({ pi: { ...pi(), voiceEnabled: true } }, 'pi.voiceEnabled', /not supported/);
});

test('unknown settings are rejected instead of silently ignored', () => {
  rejects({ pi: pi(), wiki: { checkout: '/srv/wiki' } }, 'wiki', /unknown/);
  rejects({ pi: { ...pi(), agentDir: '/srv/natsumi-pi/agent' } }, 'pi.agentDir', /unknown/);
});

test('the data directory is chosen on the command line, not in the config', () => {
  rejects({ pi: pi(), dataDirectory: '/srv/natsumi-data' }, 'dataDirectory', /--data-dir/);
});

test('secrets written directly into the config are refused without echoing them', () => {
  const secret = 'fixture-secret-value';
  for (const [raw, path] of [
    [{ pi: pi(), github: { clientSecret: secret } }, 'github.clientSecret'],
    [{ pi: { ...pi(), apiKey: secret } }, 'pi.apiKey'],
    [{ pi: { ...pi(), accessToken: secret } }, 'pi.accessToken'],
    [{ pi: { ...pi(), model: { provider: 'x', id: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' } } }, 'pi.model.id'],
    [{ pi: pi(), google: { privateKey: '-----BEGIN PRIVATE KEY-----' } }, 'google.privateKey'],
  ] as const) {
    assert.throws(() => parseConfig(raw), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.path, path);
      assert.match(error.message, /secret/);
      assert.doesNotMatch(error.message, /fixture-secret-value|ghp_|BEGIN/);
      return true;
    });
  }
});

test('secret references are environment variable names or secret file paths', () => {
  assert.equal(envReference('NATSUMI_GITHUB_CLIENT_SECRET', 'github.clientSecretEnv'), 'NATSUMI_GITHUB_CLIENT_SECRET');
  assert.throws(() => envReference('not an env name', 'github.clientSecretEnv'),
    (error: unknown) => error instanceof ConfigError && error.path === 'github.clientSecretEnv');
  // A value in an *Env / *File field that is not a name or path is treated as a leaked secret.
  rejects({ pi: pi(), github: { clientSecretEnv: 'abc123-literal' } }, 'github.clientSecretEnv', /secret/);
  rejects({ pi: pi(), google: { credentialsFile: 'inline-json' } }, 'google.credentialsFile', /secret/);
});

test('an unreadable or malformed config file stops startup with a clear error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-config-'));
  try {
    await assert.rejects(loadConfig(join(root, 'missing.json')),
      (error: unknown) => error instanceof ConfigError && /cannot read/.test(error.message));
    await writeFile(join(root, 'broken.json'), '{ "pi": ');
    await assert.rejects(loadConfig(join(root, 'broken.json')),
      (error: unknown) => error instanceof ConfigError && /JSON/.test(error.message));
  } finally { await rm(root, { recursive: true, force: true }); }
});
