import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Must never appear in natsumi's logs or responses. */
export const ACME_UPSTREAM_DETAIL = 'fixture-acme-upstream-private-detail';

interface Authorization { domain: string; token: string; status: 'pending' | 'valid' | 'invalid'; thumbprint: string }
interface Order {
  account: string; domain: string; status: 'pending' | 'ready' | 'processing' | 'valid' | 'invalid';
  authorizations: string[]; certificate?: string;
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * A local stand-in for an ACME CA (RFC 8555, HTTP-01 only). It checks JWS signatures, nonces and URLs,
 * validates challenges by fetching them from natsumi's plaintext listener, and signs CSRs with openssl.
 */
export class AcmeStub {
  /** Failing requests answer with a problem document carrying ACME_UPSTREAM_DETAIL. */
  failing = false;
  /** The next signed request is refused with badNonce once. */
  badNonceOnce = false;
  /** Lifetime of issued certificates. */
  certificateDays = 90;
  /** Distinct account keys that registered, and orders created. */
  readonly accountKeys = new Set<string>();
  orders = 0;
  /** Every challenge token handed out, and the key authorizations natsumi served for them. */
  readonly tokens: string[] = [];
  readonly served: string[] = [];
  caPem = '';
  url = '';

  private readonly nonces = new Set<string>();
  private readonly authorizations = new Map<string, Authorization>();
  private readonly orderMap = new Map<string, Order>();
  private readonly certificates = new Map<string, string>();
  private readonly validationPort: () => number;
  private server!: Server;
  private work = '';

  constructor(options: { validationPort: () => number }) { this.validationPort = options.validationPort; }

  get directoryUrl() { return `${this.url}/directory`; }

  async start() {
    this.work = await mkdtemp(join(tmpdir(), 'natsumi-acme-stub-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '3650',
      '-subj', '/CN=natsumi fixture CA', '-keyout', join(this.work, 'ca-key.pem'), '-out', join(this.work, 'ca.pem')], { stdio: 'ignore' });
    this.caPem = await readFile(join(this.work, 'ca.pem'), 'utf8');
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
    });
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close() {
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
    await rm(this.work, { recursive: true, force: true });
  }

  private nonce(res: ServerResponse) {
    const nonce = randomBytes(12).toString('base64url');
    this.nonces.add(nonce);
    res.setHeader('replay-nonce', nonce);
    res.setHeader('cache-control', 'no-store');
  }

  private problem(res: ServerResponse, status: number, type: string) {
    this.nonce(res);
    res.writeHead(status, { 'content-type': 'application/problem+json' })
      .end(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail: ACME_UPSTREAM_DETAIL, status }));
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    this.nonce(res);
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', this.url).pathname;
    if (req.method === 'GET' && path === '/directory') {
      return this.json(res, 200, {
        newNonce: `${this.url}/new-nonce`, newAccount: `${this.url}/new-account`, newOrder: `${this.url}/new-order`,
        meta: { termsOfService: `${this.url}/terms` },
      });
    }
    if ((req.method === 'HEAD' || req.method === 'GET') && path === '/new-nonce') { this.nonce(res); res.writeHead(200).end(); return; }
    if (req.method !== 'POST') return this.problem(res, 405, 'malformed');

    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    if (req.headers['content-type'] !== 'application/jose+json') return this.problem(res, 415, 'malformed');
    const jws = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { protected: string; payload: string; signature: string };
    const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8')) as
      { alg: string; nonce: string; url: string; jwk?: JsonWebKey; kid?: string };
    if (header.alg !== 'ES256' || header.url !== `${this.url}${path}`) return this.problem(res, 400, 'malformed');
    if (!this.nonces.delete(header.nonce) || this.badNonceOnce) {
      this.badNonceOnce = false;
      return this.problem(res, 400, 'badNonce');
    }
    let jwk: JsonWebKey;
    if (path === '/new-account') {
      if (!header.jwk || header.kid) return this.problem(res, 400, 'malformed');
      jwk = header.jwk;
    } else {
      const account = header.kid?.startsWith(`${this.url}/account/`) ? header.kid.slice(`${this.url}/account/`.length) : undefined;
      const known = account ? [...this.accountKeys].find(key => thumbprint(JSON.parse(key) as JsonWebKey) === account) : undefined;
      if (!known || header.jwk) return this.problem(res, 401, 'accountDoesNotExist');
      jwk = JSON.parse(known) as JsonWebKey;
    }
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (!verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url'))) {
      return this.problem(res, 400, 'malformed');
    }
    if (this.failing) return this.problem(res, 500, 'serverInternal');
    const payload = jws.payload === '' ? undefined : JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const account = thumbprint(jwk);

    if (path === '/new-account') {
      if (payload?.termsOfServiceAgreed !== true) return this.problem(res, 400, 'malformed');
      const serialized = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
      const existing = this.accountKeys.has(serialized);
      this.accountKeys.add(serialized);
      return this.json(res, existing ? 200 : 201, { status: 'valid' }, { location: `${this.url}/account/${account}` });
    }
    if (path === '/new-order') {
      const identifiers = payload?.identifiers as { type: string; value: string }[] | undefined;
      const domain = identifiers?.length === 1 && identifiers[0]?.type === 'dns' ? identifiers[0].value : undefined;
      if (!domain) return this.problem(res, 400, 'rejectedIdentifier');
      this.orders += 1;
      const token = randomBytes(16).toString('base64url');
      this.tokens.push(token);
      const authId = randomBytes(8).toString('hex');
      this.authorizations.set(authId, { domain, token, status: 'pending', thumbprint: account });
      const orderId = randomBytes(8).toString('hex');
      const order: Order = { account, domain, status: 'pending', authorizations: [authId] };
      this.orderMap.set(orderId, order);
      return this.json(res, 201, this.orderBody(orderId, order), { location: `${this.url}/order/${orderId}` });
    }
    const [, kind, id = ''] = path.split('/');
    if (kind === 'authz' && this.authorizations.has(id)) {
      return this.json(res, 200, this.authorizationBody(id, this.authorizations.get(id)!));
    }
    if (kind === 'challenge' && this.authorizations.has(id)) {
      const authorization = this.authorizations.get(id)!;
      if (authorization.status === 'pending') {
        const served = await fetch(`http://127.0.0.1:${this.validationPort()}/.well-known/acme-challenge/${authorization.token}`,
          { headers: { host: authorization.domain }, redirect: 'manual' }).then(async r => (r.status === 200 ? r.text() : ''), () => '');
        this.served.push(served);
        authorization.status = served.trim() === `${authorization.token}.${authorization.thumbprint}` ? 'valid' : 'invalid';
        for (const order of this.orderMap.values()) {
          if (order.authorizations.includes(id) && order.status === 'pending') order.status = authorization.status === 'valid' ? 'ready' : 'invalid';
        }
      }
      return this.json(res, 200, this.challengeBody(id, authorization));
    }
    if (kind === 'order' && this.orderMap.has(id)) {
      const order = this.orderMap.get(id)!;
      if (order.account !== account) return this.problem(res, 403, 'unauthorized');
      return this.json(res, 200, this.orderBody(id, order));
    }
    if (kind === 'finalize' && this.orderMap.has(id)) {
      const order = this.orderMap.get(id)!;
      if (order.status !== 'ready' || typeof payload?.csr !== 'string') return this.problem(res, 403, 'orderNotReady');
      const csr = join(this.work, `${id}.csr.pem`);
      await writeFile(csr, `-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.from(payload.csr, 'base64url').toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`);
      const text = execFileSync('openssl', ['req', '-in', csr, '-noout', '-verify', '-text'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (!text.includes(`DNS:${order.domain}`)) return this.problem(res, 400, 'badCSR');
      const leaf = execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', join(this.work, 'ca.pem'), '-CAkey', join(this.work, 'ca-key.pem'),
        '-days', String(this.certificateDays), '-set_serial', `0x${randomBytes(8).toString('hex')}`, '-copy_extensions', 'copyall'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      this.certificates.set(id, `${leaf}${this.caPem}`);
      order.status = 'valid';
      order.certificate = `${this.url}/cert/${id}`;
      return this.json(res, 200, this.orderBody(id, order), { location: `${this.url}/order/${id}` });
    }
    if (kind === 'cert' && this.certificates.has(id)) {
      this.nonce(res);
      res.writeHead(200, { 'content-type': 'application/pem-certificate-chain' }).end(this.certificates.get(id));
      return;
    }
    return this.problem(res, 404, 'malformed');
  }

  private orderBody(id: string, order: Order) {
    return {
      status: order.status, identifiers: [{ type: 'dns', value: order.domain }],
      authorizations: order.authorizations.map(a => `${this.url}/authz/${a}`),
      finalize: `${this.url}/finalize/${id}`, ...(order.certificate ? { certificate: order.certificate } : {}),
    };
  }

  private authorizationBody(id: string, authorization: Authorization) {
    return { status: authorization.status, identifier: { type: 'dns', value: authorization.domain }, challenges: [
      { type: 'dns-01', url: `${this.url}/unused/${id}`, status: 'pending', token: 'unused' },
      this.challengeBody(id, authorization),
    ] };
  }

  private challengeBody(id: string, authorization: Authorization) {
    return { type: 'http-01', url: `${this.url}/challenge/${id}`, status: authorization.status, token: authorization.token };
  }
}

/** RFC 7638 thumbprint of an EC P-256 key. */
export function thumbprint(jwk: JsonWebKey): string {
  return b64(createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}
