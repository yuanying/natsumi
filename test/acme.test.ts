import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connect } from 'node:tls';
import WebSocket from 'ws';
import { createCsr } from '../src/server/acme.ts';
import { CertificateManager } from '../src/server/certificates.ts';
import { openChallengeListener } from '../src/server/challenge.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { checkHealth, readStatus } from '../src/server/status.ts';
import { ACME_UPSTREAM_DETAIL, AcmeStub } from './support/acme-stub.ts';
import { CLIENT_SECRET, PUBLIC_ORIGIN, serverConfig } from './support/server-fixture.ts';

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = !hasOpenssl && 'openssl is not available';
const HOST = new URL(PUBLIC_ORIGIN).hostname;
const DAY = 86_400_000;
const MINUTE = 60_000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** natsumi with ACME against a local stub CA. GitHub points at a closed loopback port and is never reached. */
async function setup(options: { failing?: boolean; badNonceOnce?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-acme-')));
  const data = join(root, 'data');
  await mkdir(data);
  const httpPort = await freePort();
  const stub = await new AcmeStub({ validationPort: () => httpPort }).start();
  stub.failing = options.failing ?? false;
  stub.badNonceOnce = options.badNonceOnce ?? false;
  const config = join(root, 'config.json');
  const listen = { host: '127.0.0.1', port: 0, tls: { acme: { directoryUrl: stub.directoryUrl, contactEmail: 'owner@example.test', httpPort } } };
  await writeFile(config, JSON.stringify(serverConfig(root, { listen })));
  const logs: string[] = [];
  const clock = { now: Date.now(), advance(ms: number) { this.now += ms; } };
  const closed = 'http://127.0.0.1:9';
  const servers: RunningServer[] = [];
  const f = {
    root, data, stub, logs, clock, httpPort, config,
    async start() {
      const server = await startServer({
        config, dataDir: data, cwd: '/', home: join(root, 'home'), env: { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET },
        github: { authorizeUrl: `${closed}/authorize`, tokenUrl: `${closed}/token`, userUrl: `${closed}/user` },
        clock: () => clock.now, log: line => { logs.push(line); }, acme: { pollIntervalMs: 5 },
      });
      servers.push(server);
      return server;
    },
    async cleanup() {
      for (const server of servers) await server.stop();
      await stub.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

/** The serial number of the certificate a new TLS connection is served, verified against the stub CA for HOST. */
function servedSerial(port: number, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, servername: HOST, ca }, () => {
      const serial = socket.getPeerCertificate().serialNumber;
      socket.end();
      resolve(serial);
    });
    socket.once('error', reject);
  });
}

interface Plain { status: number; location: string | undefined; body: string }

/** A raw request to the plaintext listener; `path` may be absolute-form. */
function plain(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Plain> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

const leaks = /PRIVATE KEY|BEGIN|fixture-acme-upstream|fixture-client-secret/;

test('a CSR names the host in subjectAltName and is signed by the certificate key', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-csr-'));
  try {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = createCsr(HOST, privateKey);
    const file = join(root, 'request.der');
    await writeFile(file, der);
    const text = execFileSync('openssl', ['req', '-inform', 'DER', '-in', file, '-noout', '-verify', '-text'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(text, new RegExp(`DNS:${HOST.replaceAll('.', '\\.')}`));
    const long = `${'a'.repeat(60)}.example.test`;
    await writeFile(file, createCsr(long, privateKey));
    assert.match(execFileSync('openssl', ['req', '-inform', 'DER', '-in', file, '-noout', '-verify', '-text'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), new RegExp(`DNS:${long}`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('without a certificate, HTTPS opens only once one is issued; failures back off and log no upstream detail', { skip }, async () => {
  const f = await setup({ failing: true });
  try {
    const server = await f.start();
    await server.checkCertificate();
    assert.equal(server.address, undefined, 'no HTTPS listener without a certificate');
    assert.ok(server.challengeAddress, 'the challenge listener is open');
    const status = await readStatus(f.data);
    assert.equal(status?.state, 'waiting-for-certificate');
    assert.equal(checkHealth(status).healthy, false);

    // Failed attempts are not retried until the back-off passes.
    f.stub.failing = false;
    const orders = f.stub.orders;
    await server.checkCertificate();
    assert.equal(f.stub.orders, orders);
    assert.equal(server.address, undefined);

    f.stub.badNonceOnce = true;
    f.clock.advance(16 * MINUTE);
    await server.checkCertificate();
    const { port } = await server.listening;
    assert.deepEqual(server.address, { host: '127.0.0.1', port });
    assert.equal(f.stub.served.at(-1)?.startsWith(`${f.stub.tokens.at(-1)}.`), true, 'the challenge was answered');
    assert.ok(await servedSerial(port, f.stub.caPem));
    assert.equal((await readStatus(f.data))?.state, 'running');

    assert.ok(f.logs.some(line => /acme/.test(line)), 'ACME progress is logged');
    assert.doesNotMatch(f.logs.join('\n'), leaks);
    assert.doesNotMatch(f.logs.join('\n'), new RegExp(ACME_UPSTREAM_DETAIL));
  } finally { await f.cleanup(); }
});

test('the plaintext listener answers only pending challenges and never reaches login, the API or WebSocket', { skip }, async () => {
  const f = await setup();
  try {
    const server = await f.start();
    await server.listening;
    const port = f.httpPort;
    assert.deepEqual(server.challengeAddress, { host: '127.0.0.1', port });

    // The token was answered while pending and is forgotten once the order is done.
    const token = f.stub.tokens.at(-1)!;
    const done = await plain(port, 'GET', `/.well-known/acme-challenge/${token}`);
    assert.equal(done.status, 404);
    assert.equal((await plain(port, 'GET', '/.well-known/acme-challenge/unknown-token')).status, 404);

    const redirect = await plain(port, 'GET', '/auth/github/start?state=x', { host: 'attacker.example' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.location, `${PUBLIC_ORIGIN}/auth/github/start?state=x`);
    assert.equal((await plain(port, 'HEAD', '/')).location, `${PUBLIC_ORIGIN}/`);
    for (const path of ['http://attacker.example/steal', '//attacker.example/steal']) {
      const res = await plain(port, 'GET', path);
      assert.equal(res.status, 301);
      assert.equal(new URL(res.location!).origin, PUBLIC_ORIGIN, path);
    }
    for (const [method, path] of [['POST', '/auth/session'], ['POST', '/auth/logout'], ['PUT', '/v1/ws'], ['DELETE', '/']] as const) {
      const res = await plain(port, method, path, { authorization: 'Bearer fixture-token' });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    const upgrade = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: 'Bearer fixture-token' } });
      ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); res.resume(); ws.terminate(); });
      ws.once('open', () => { ws.close(); reject(new Error('upgraded on the plaintext listener')); });
      ws.once('error', () => resolve(0));
    });
    assert.notEqual(upgrade, 101);
    assert.notEqual(upgrade, 401, 'the session check was never reached');
    assert.doesNotMatch(f.logs.join('\n'), leaks);
  } finally { await f.cleanup(); }
});

test('the account key and certificate are stored privately and reused after a restart', { skip }, async () => {
  const f = await setup();
  try {
    const first = await f.start();
    const serial = await servedSerial((await first.listening).port, f.stub.caPem);
    await first.stop();
    assert.equal(f.stub.orders, 1);
    assert.equal(f.stub.accountKeys.size, 1);

    const acme = join(f.data, '.natsumi', 'acme');
    assert.equal((await stat(acme)).mode & 0o777, 0o700);
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { assert.equal((await stat(path)).mode & 0o777, 0o700, path); await walk(path); } else files.push(path);
      }
    };
    await walk(acme);
    assert.ok(files.length >= 2, 'an account key and a certificate are stored');
    for (const file of files) assert.equal((await stat(file)).mode & 0o777, 0o600, file);
    assert.ok((await Promise.all(files.map(file => readFile(file, 'utf8')))).some(text => text.includes('PRIVATE KEY')));

    const second = await f.start();
    assert.ok(second.address, 'a stored certificate opens HTTPS immediately');
    assert.equal(await servedSerial(second.address.port, f.stub.caPem), serial);
    await second.checkCertificate();
    assert.equal(f.stub.orders, 1, 'no new order for a certificate that is not due');
    assert.equal(f.stub.accountKeys.size, 1);
  } finally { await f.cleanup(); }
});

test('a certificate near expiry is renewed and used for new connections without a restart; a failed renewal keeps the old one', { skip }, async () => {
  const f = await setup();
  try {
    const server = await f.start();
    const { port } = await server.listening;
    const original = await servedSerial(port, f.stub.caPem);

    f.clock.advance(70 * DAY);
    f.stub.failing = true;
    await server.checkCertificate();
    assert.equal(await servedSerial(port, f.stub.caPem), original, 'still serving the old certificate');
    assert.equal((await readStatus(f.data))?.state ?? 'running', 'running');
    const orders = f.stub.orders;
    await server.checkCertificate();
    assert.equal(f.stub.orders, orders, 'retries wait for the back-off');

    f.stub.failing = false;
    f.clock.advance(16 * MINUTE);
    await server.checkCertificate();
    const renewed = await servedSerial(port, f.stub.caPem);
    assert.notEqual(renewed, original);
    assert.equal(f.stub.accountKeys.size, 1, 'the account key is reused for renewal');
    assert.doesNotMatch(f.logs.join('\n'), leaks);

    // The renewed certificate is what a restart loads.
    await server.stop();
    const again = await f.start();
    assert.equal(await servedSerial(again.address!.port, f.stub.caPem), renewed);
  } finally { await f.cleanup(); }
});

test('a stored certificate for another host is not used', { skip }, async () => {
  const f = await setup();
  try {
    const first = await f.start();
    await first.listening;
    await first.stop();
    assert.equal(f.stub.orders, 1);
    const config = JSON.parse(await readFile(f.config, 'utf8')) as ReturnType<typeof serverConfig>;
    const origin = 'https://other.example.test';
    await writeFile(f.config, JSON.stringify({ ...config, publicOrigin: origin, github: { ...config.github, callbackUrl: `${origin}/auth/github/callback` } }));
    const server = await f.start();
    await server.listening;
    assert.equal(f.stub.orders, 2);
  } finally { await f.cleanup(); }
});

test('without ACME no plaintext listener is opened', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-noacme-')));
  try {
    const data = join(root, 'data');
    await mkdir(data);
    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify(serverConfig(root)));
    const server = await startServer({ config, dataDir: data, cwd: '/', home: join(root, 'home'), env: { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET } });
    try {
      assert.equal(server.challengeAddress, undefined);
      assert.deepEqual(await server.listening, server.address);
      await server.checkCertificate();
    } finally { await server.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the manager hands over the first certificate and every renewal, and never the same one twice', { skip }, async () => {
  const f = await setup();
  try {
    const manager = await CertificateManager.open({
      stateDirectory: join(f.data, '.natsumi'), hostname: HOST, now: () => f.clock.now, pollIntervalMs: 5,
      acme: { directoryUrl: f.stub.directoryUrl, contactEmail: 'owner@example.test', httpPort: f.httpPort },
      log: line => { f.logs.push(line); },
    });
    const challenge = await openChallengeListener({
      host: '127.0.0.1', port: f.httpPort, publicOrigin: PUBLIC_ORIGIN, challenges: manager.challenges,
    });
    const served: string[] = [];
    try {
      // Starting with nothing stored: the first certificate reaches the listener once.
      await manager.start(async certificate => { served.push(certificate.cert.toString('utf8')); });
      await manager.checkCertificate();
      assert.equal(f.stub.orders, 1);
      assert.equal(served.length, 1);

      // A certificate that is not due is neither re-ordered nor handed over again.
      await manager.checkCertificate();
      assert.equal(f.stub.orders, 1);
      assert.equal(served.length, 1);

      // Near expiry it is renewed, and only the new one is handed over.
      f.clock.advance(70 * DAY);
      await manager.checkCertificate();
      assert.equal(f.stub.orders, 2);
      assert.equal(served.length, 2);
      assert.notEqual(served[1], served[0]);

      // A failed renewal keeps the current certificate, hands nothing over, and backs off before retrying.
      f.clock.advance(70 * DAY);
      f.stub.failing = true;
      await manager.checkCertificate();
      assert.equal(served.length, 2);
      const orders = f.stub.orders;
      f.stub.failing = false;
      await manager.checkCertificate();
      assert.equal(f.stub.orders, orders, 'the retry waits for the back-off');
      f.clock.advance(16 * MINUTE);
      await manager.checkCertificate();
      assert.equal(served.length, 3);
      assert.doesNotMatch(f.logs.join('\n'), leaks);
    } finally { await challenge.close(); await manager.close(); }
  } finally { await f.cleanup(); }
});
