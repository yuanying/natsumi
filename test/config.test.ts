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

const tls = () => ({ certFile: '/run/secrets/natsumi-tls-cert', keyFile: '/run/secrets/natsumi-tls-key' });
const listen = () => ({ host: '::', port: 8443, tls: tls() });
const github = () => ({
  clientId: 'Iv1.fixtureclient',
  clientSecretEnv: 'NATSUMI_GITHUB_CLIENT_SECRET',
  callbackUrl: 'https://natsumi.example.test/auth/github/callback',
  allowedUserId: 4242001,
});
const base = () => ({ pi: pi(), publicOrigin: 'https://natsumi.example.test', listen: listen(), github: github() });

function rejects(raw: unknown, path: string, reason?: RegExp) {
  assert.throws(() => parseConfig(raw), (error: unknown) => {
    assert.ok(error instanceof ConfigError, String(error));
    assert.equal(error.path, path);
    if (reason) assert.match(error.message, reason);
    return true;
  });
}

test('a valid config becomes a typed server config', () => {
  assert.deepEqual(parseConfig(base()), {
    pi: pi(),
    publicOrigin: 'https://natsumi.example.test',
    listen: { host: '::', port: 8443, tls: tls() },
    github: {
      clientId: 'Iv1.fixtureclient',
      clientSecret: { env: 'NATSUMI_GITHUB_CLIENT_SECRET' },
      callbackUrl: 'https://natsumi.example.test/auth/github/callback',
      allowedUserId: 4242001,
    },
  });
  const { clientSecretEnv: _, ...rest } = github();
  assert.deepEqual(parseConfig({ ...base(), github: { ...rest, clientSecretFile: '/run/secrets/github-client-secret' } }).github.clientSecret,
    { file: '/run/secrets/github-client-secret' });
});

test('the shipped example config is valid', async () => {
  const config = await loadConfig(new URL('../config.example.json', import.meta.url).pathname);
  assert.equal(config.pi.voiceEnabled, false);
  assert.notEqual(config.listen.tls, false);
});

test('invalid values name the offending setting', () => {
  rejects(null, 'config', /object/);
  rejects({}, 'pi', /required/);
  rejects({ ...base(), pi: { ...pi(), agentDirectory: 'relative/agent' } }, 'pi.agentDirectory', /absolute/);
  rejects({ ...base(), pi: { ...pi(), sessionDirectory: '' } }, 'pi.sessionDirectory');
  rejects({ ...base(), pi: { ...pi(), authPath: 42 } }, 'pi.authPath');
  rejects({ ...base(), pi: { ...pi(), model: { provider: 'openai-codex' } } }, 'pi.model.id', /required/);
  rejects({ ...base(), pi: { ...pi(), voiceEnabled: true } }, 'pi.voiceEnabled', /not supported/);
});

test('the connection and GitHub sections are required', () => {
  const { publicOrigin: _o, ...noOrigin } = base();
  rejects(noOrigin, 'publicOrigin', /required/);
  const { listen: _l, ...noListen } = base();
  rejects(noListen, 'listen', /required/);
  const { github: _g, ...noGitHub } = base();
  rejects(noGitHub, 'github', /required/);
});

test('unknown settings are rejected instead of silently ignored', () => {
  rejects({ ...base(), wiki: { checkout: '/srv/wiki' } }, 'wiki', /unknown/);
  rejects({ ...base(), pi: { ...pi(), agentDir: '/srv/natsumi-pi/agent' } }, 'pi.agentDir', /unknown/);
  rejects({ ...base(), listen: { ...listen(), backlog: 5 } }, 'listen.backlog', /unknown/);
  rejects({ ...base(), github: { ...github(), allowedLogin: 'fictional-owner' } }, 'github.allowedLogin', /unknown/);
});

test('the data directory is chosen on the command line, not in the config', () => {
  rejects({ ...base(), dataDirectory: '/srv/natsumi-data' }, 'dataDirectory', /--data-dir/);
});

test('plaintext listening is refused unless the host is loopback', () => {
  for (const host of ['::', '0.0.0.0', '192.0.2.10', '2001:db8::10']) {
    rejects({ ...base(), listen: { host, port: 8080, tls: false } }, 'listen.tls', /loopback/);
  }
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.equal(parseConfig({ ...base(), listen: { host, port: 8080, tls: false } }).listen.tls, false);
  }
  rejects({ ...base(), listen: { host: '::', port: 8443 } }, 'listen.tls', /required/);
  rejects({ ...base(), listen: { host: '::', port: 8443, tls: true } }, 'listen.tls');
  rejects({ ...base(), listen: { ...listen(), tls: { certFile: tls().certFile } } }, 'listen.tls.keyFile', /required/);
  rejects({ ...base(), listen: { ...listen(), tls: { ...tls(), certFile: 'cert.pem' } } }, 'listen.tls.certFile');
});

test('the listen address is an IP literal or localhost and a valid port', () => {
  rejects({ ...base(), listen: { ...listen(), host: 'natsumi.example.test' } }, 'listen.host', /IP address/);
  rejects({ ...base(), listen: { ...listen(), host: '' } }, 'listen.host');
  for (const port of [-1, 65536, 1.5, '8443']) rejects({ ...base(), listen: { ...listen(), port } }, 'listen.port');
  assert.equal(parseConfig({ ...base(), listen: { ...listen(), port: 0 } }).listen.port, 0);
});

test('the public origin is an https origin, or http only on loopback', () => {
  rejects({ ...base(), publicOrigin: 'http://natsumi.example.test' }, 'publicOrigin', /https/);
  rejects({ ...base(), publicOrigin: 'https://natsumi.example.test/app' }, 'publicOrigin', /origin/);
  rejects({ ...base(), publicOrigin: 'https://natsumi.example.test?x=1' }, 'publicOrigin', /origin/);
  rejects({ ...base(), publicOrigin: 'not a url' }, 'publicOrigin');
  const local = { ...base(), publicOrigin: 'http://127.0.0.1:8080',
    github: { ...github(), callbackUrl: 'http://127.0.0.1:8080/auth/github/callback' } };
  assert.equal(parseConfig(local).publicOrigin, 'http://127.0.0.1:8080');
  assert.equal(parseConfig({ ...base(), publicOrigin: 'https://natsumi.example.test/' }).publicOrigin, 'https://natsumi.example.test');
});

test('GitHub access is granted to one numeric user ID, never a login name', () => {
  for (const allowedUserId of ['fictional-owner', '4242001', 0, -5, 1.5, [4242001]]) {
    rejects({ ...base(), github: { ...github(), allowedUserId } }, 'github.allowedUserId', /numeric/);
  }
  rejects({ ...base(), github: { ...github(), clientId: '' } }, 'github.clientId');
});

test('the GitHub client secret is referenced exactly once, by env or file', () => {
  const { clientSecretEnv: _, ...none } = github();
  rejects({ ...base(), github: none }, 'github.clientSecretEnv', /clientSecretFile/);
  rejects({ ...base(), github: { ...github(), clientSecretFile: '/run/secrets/github-client-secret' } }, 'github.clientSecretFile', /only one/);
});

test('the GitHub callback URL is the callback path on the public origin', () => {
  rejects({ ...base(), github: { ...github(), callbackUrl: 'https://other.example.test/auth/github/callback' } }, 'github.callbackUrl', /publicOrigin/);
  rejects({ ...base(), github: { ...github(), callbackUrl: 'https://natsumi.example.test/callback' } }, 'github.callbackUrl', /\/auth\/github\/callback/);
  rejects({ ...base(), github: { ...github(), callbackUrl: 'https://natsumi.example.test/auth/github/callback?next=x' } }, 'github.callbackUrl');
});

test('secrets written directly into the config are refused without echoing them', () => {
  const secret = 'fixture-secret-value';
  for (const [raw, path] of [
    [{ ...base(), github: { ...github(), clientSecret: secret } }, 'github.clientSecret'],
    [{ ...base(), pi: { ...pi(), apiKey: secret } }, 'pi.apiKey'],
    [{ ...base(), pi: { ...pi(), accessToken: secret } }, 'pi.accessToken'],
    [{ ...base(), pi: { ...pi(), model: { provider: 'x', id: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' } } }, 'pi.model.id'],
    [{ ...base(), google: { privateKey: '-----BEGIN PRIVATE KEY-----' } }, 'google.privateKey'],
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
  rejects({ ...base(), github: { ...github(), clientSecretEnv: 'abc123-literal' } }, 'github.clientSecretEnv', /secret/);
  rejects({ ...base(), google: { credentialsFile: 'inline-json' } }, 'google.credentialsFile', /secret/);
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
