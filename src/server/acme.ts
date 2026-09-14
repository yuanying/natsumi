import { createHash, createPublicKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * An ACME failure. The message holds the step and a fixed reason or the RFC 8555 error type only:
 * never upstream text, URLs or key material (ADR 0007).
 */
export class AcmeError extends Error {
  constructor(step: string, reason: string) {
    super(`acme: ${step} failed (${reason})`);
    this.name = 'AcmeError';
  }
}

export interface IssueOptions {
  directoryUrl: string;
  /** EC P-256 account key. */
  accountKey: KeyObject;
  contactEmail?: string;
  hostname: string;
  /** Token → key authorization. Filled while an order is in progress, for the plaintext listener to serve. */
  challenges: Map<string, string>;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

export interface IssuedCertificate { certificatePem: string; privateKeyPem: string }

export const CERTIFICATE_PEM = /-----BEGIN CERTIFICATE-----\r?\n[\s\S]+?-----END CERTIFICATE-----/g;

const MAX_POLLS = 60;
const MAX_WAIT_MS = 30_000;
const MAX_BODY_CHARS = 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const PROBLEM = /^urn:ietf:params:acme:error:([A-Za-z]{1,64})$/;
const FAILED_STATUS = /^[a-z]{1,32}$/;

type Json = Record<string, unknown>;
interface Reply { body: Json; text: string; location: string | undefined; retryAfterMs: number | undefined; problem?: string }

/** Obtains a certificate for one DNS name over HTTP-01, with a fresh EC P-256 certificate key. */
export function issueCertificate(options: IssueOptions): Promise<IssuedCertificate> {
  return new AcmeSession(options).issue();
}

/** The subset of RFC 8555 natsumi needs: account, order, HTTP-01 authorization, finalize and download. */
class AcmeSession {
  private readonly options: IssueOptions;
  private readonly origin: string;
  private readonly jwk: { crv: string; kty: string; x: string; y: string };
  private readonly thumbprint: string;
  private readonly pollMs: number;
  private newNonceUrl = '';
  private nonce: string | undefined;
  private kid: string | undefined;

  constructor(options: IssueOptions) {
    this.options = options;
    this.origin = new URL(options.directoryUrl).origin;
    // The public half only: exporting the private KeyObject as JWK would include `d`.
    const { crv, kty, x, y } = createPublicKey(options.accountKey).export({ format: 'jwk' });
    if (kty !== 'EC' || crv !== 'P-256' || !x || !y) throw new AcmeError('account', 'unsupported-key');
    this.jwk = { crv, kty, x, y };
    this.thumbprint = createHash('sha256').update(JSON.stringify(this.jwk)).digest('base64url');
    this.pollMs = options.pollIntervalMs ?? 2_000;
  }

  async issue(): Promise<IssuedCertificate> {
    const { hostname, challenges, contactEmail } = this.options;
    const directory = await this.directory();
    const account = await this.post(directory.newAccount,
      { termsOfServiceAgreed: true, ...(contactEmail ? { contact: [`mailto:${contactEmail}`] } : {}) }, 'account');
    this.kid = this.sameOrigin(account.location, 'account');

    const created = await this.post(directory.newOrder, { identifiers: [{ type: 'dns', value: hostname }] }, 'order');
    const orderUrl = this.sameOrigin(created.location, 'order');
    if (!Array.isArray(created.body.authorizations)) throw new AcmeError('order', 'malformed');
    const tokens: string[] = [];
    try {
      for (const entry of created.body.authorizations as unknown[]) {
        const url = this.sameOrigin(entry, 'authorization');
        const authorization = (await this.post(url, undefined, 'authorization')).body;
        if (authorization.status === 'valid') continue;
        const challenge = Array.isArray(authorization.challenges)
          ? (authorization.challenges as Json[]).find(c => c.type === 'http-01') : undefined;
        if (!challenge || typeof challenge.token !== 'string' || !TOKEN.test(challenge.token)) {
          throw new AcmeError('authorization', 'no-http-01-challenge');
        }
        challenges.set(challenge.token, `${challenge.token}.${this.thumbprint}`);
        tokens.push(challenge.token);
        if (challenge.status === 'pending') await this.post(this.sameOrigin(challenge.url, 'challenge'), {}, 'challenge');
        await this.poll(url, 'authorization', ['valid']);
      }
    } finally {
      // Only tokens of an order in progress are ever answered.
      for (const token of tokens) challenges.delete(token);
    }

    let order = await this.poll(orderUrl, 'order', ['ready', 'valid']);
    if (order.status !== 'ready') throw new AcmeError('order', 'unexpected-status');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await this.post(this.sameOrigin(order.finalize, 'finalize'), { csr: createCsr(hostname, privateKey).toString('base64url') }, 'finalize');
    order = await this.poll(orderUrl, 'order', ['valid']);
    const chain = (await this.post(this.sameOrigin(order.certificate, 'certificate'), undefined, 'certificate')).text.match(CERTIFICATE_PEM);
    if (!chain?.[0]) throw new AcmeError('certificate', 'malformed');
    const leaf = new X509Certificate(chain[0]);
    if (leaf.checkHost(hostname) === undefined || !leaf.checkPrivateKey(privateKey)) throw new AcmeError('certificate', 'mismatch');
    return { certificatePem: `${chain.join('\n')}\n`, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
  }

  private async directory() {
    const reply = await this.request(this.options.directoryUrl, 'directory', { method: 'GET' });
    if (reply.problem !== undefined) throw new AcmeError('directory', reply.problem);
    this.newNonceUrl = this.sameOrigin(reply.body.newNonce, 'directory');
    return { newAccount: this.sameOrigin(reply.body.newAccount, 'directory'), newOrder: this.sameOrigin(reply.body.newOrder, 'directory') };
  }

  private async freshNonce(): Promise<string> {
    this.nonce = undefined;
    const reply = await this.request(this.newNonceUrl, 'nonce', { method: 'HEAD' });
    const nonce = this.nonce;
    if (reply.problem !== undefined || nonce === undefined) throw new AcmeError('nonce', reply.problem ?? 'missing');
    return nonce;
  }

  /** A JWS-signed POST (`payload` undefined is POST-as-GET). A rejected nonce is retried with a new one. */
  private async post(url: string, payload: Json | undefined, step: string): Promise<Reply> {
    for (let attempt = 0; ; attempt += 1) {
      const nonce = this.nonce ?? await this.freshNonce();
      this.nonce = undefined;
      const header = { alg: 'ES256', nonce, url, ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }) };
      const protectedPart = Buffer.from(JSON.stringify(header)).toString('base64url');
      const payloadPart = payload === undefined ? '' : Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signature = sign('sha256', Buffer.from(`${protectedPart}.${payloadPart}`),
        { key: this.options.accountKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      const reply = await this.request(url, step, {
        method: 'POST', headers: { 'content-type': 'application/jose+json' },
        body: JSON.stringify({ protected: protectedPart, payload: payloadPart, signature }),
      });
      if (reply.problem === 'badNonce' && attempt < 3) continue;
      if (reply.problem !== undefined) throw new AcmeError(step, reply.problem);
      return reply;
    }
  }

  private async request(url: string, step: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        ...init, headers: { 'user-agent': 'natsumi-acme', ...init.headers }, redirect: 'error', signal: this.options.signal,
      });
      text = await response.text();
    } catch {
      throw new AcmeError(step, this.options.signal?.aborted ? 'aborted' : 'unreachable');
    }
    const nonce = response.headers.get('replay-nonce');
    if (nonce && /^[A-Za-z0-9_-]{1,256}$/.test(nonce)) this.nonce = nonce;
    if (text.length > MAX_BODY_CHARS) throw new AcmeError(step, 'response-too-large');
    let body: Json = {};
    if (/json/.test(response.headers.get('content-type') ?? '')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Json;
      } catch { throw new AcmeError(step, 'malformed'); }
    }
    const seconds = Number(response.headers.get('retry-after'));
    const reply: Reply = {
      body, text, location: response.headers.get('location') ?? undefined,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
    };
    if (!response.ok) reply.problem = (typeof body.type === 'string' ? PROBLEM.exec(body.type)?.[1] : undefined) ?? `http-${response.status}`;
    return reply;
  }

  private async poll(url: string, step: string, done: string[]): Promise<Json> {
    for (let i = 0; i < MAX_POLLS; i += 1) {
      const { body, retryAfterMs } = await this.post(url, undefined, step);
      const status = body.status;
      if (typeof status !== 'string') throw new AcmeError(step, 'malformed');
      if (done.includes(status)) return body;
      if (!['pending', 'processing', 'ready'].includes(status)) throw new AcmeError(step, FAILED_STATUS.test(status) ? status : 'malformed');
      try {
        await delay(Math.min(Math.max(retryAfterMs ?? 0, this.pollMs), MAX_WAIT_MS), undefined, { signal: this.options.signal });
      } catch { throw new AcmeError(step, 'aborted'); }
    }
    throw new AcmeError(step, 'timeout');
  }

  /** Every URL the CA hands back must be on the directory's origin. */
  private sameOrigin(value: unknown, step: string): string {
    if (typeof value !== 'string') throw new AcmeError(step, 'malformed');
    let url: URL;
    try { url = new URL(value); } catch { throw new AcmeError(step, 'malformed'); }
    if (url.origin !== this.origin) throw new AcmeError(step, 'foreign-url');
    return url.href;
  }
}

// PKCS#10 in DER. Node has no CSR builder, and one EC key with one DNS name needs only a few structures.

const OID = {
  commonName: '2.5.4.3',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectAltName: '2.5.29.17',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
};

/** A CSR for `hostname` (subjectAltName dNSName; also the CN when it fits in 64 characters), signed with ECDSA-SHA256. */
export function createCsr(hostname: string, privateKey: KeyObject): Buffer {
  const name = Buffer.from(hostname, 'ascii');
  const subject = hostname.length <= 64 ? tlv(0x30, tlv(0x31, tlv(0x30, oid(OID.commonName), tlv(0x0c, name)))) : tlv(0x30);
  const san = tlv(0x30, oid(OID.subjectAltName), tlv(0x04, tlv(0x30, tlv(0x82, name))));
  const attributes = tlv(0xa0, tlv(0x30, oid(OID.extensionRequest), tlv(0x31, tlv(0x30, san))));
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const info = tlv(0x30, tlv(0x02, Buffer.from([0])), subject, spki, attributes);
  const signature = sign('sha256', info, privateKey);
  return tlv(0x30, info, tlv(0x30, oid(OID.ecdsaWithSha256)), tlv(0x03, Buffer.from([0]), signature));
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  let length: Buffer;
  if (body.length < 0x80) {
    length = Buffer.from([body.length]);
  } else {
    const bytes: number[] = [];
    for (let n = body.length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const encoded = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) encoded.unshift((v & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}
