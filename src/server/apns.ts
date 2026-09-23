import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';

export type ApnsEnvironment = 'sandbox' | 'production';

/** Where each environment is sent: a development build is registered with sandbox, a distributed one with production. */
export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

/** APNs refuses a provider token older than an hour and one renewed more often than every 20 minutes. */
export const JWT_LIFETIME_MS = 50 * 60_000;
/** A request that gets no answer in this time counts as a failed connection. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface ApnsRequest {
  environment: ApnsEnvironment;
  /** The device token, in hex. */
  token: string;
  /** An alert goes out at priority 10, a background push at 5, as APNs requires for each type. */
  pushType: 'alert' | 'background';
  payload: object;
  /** The `apns-id`, a UUID. Kept the same when the same push is sent again. */
  id?: string;
}

/** The answer of APNs. `reason` is the one word APNs gives for an error, such as `Unregistered`. */
export interface ApnsResponse { status: number; reason?: string }

/** The .p8 signing key, or undefined when the text is not an EC P-256 private key. */
export function parseApnsKey(pem: string): KeyObject | undefined {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : undefined;
  } catch { return undefined; }
}

/** A provider authentication token: an ES256 JWT with the key ID in the header and the team as issuer. */
export function signApnsJwt(input: { teamId: string; keyId: string; key: KeyObject; issuedAt: number }): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: input.keyId })}.${encode({ iss: input.teamId, iat: Math.floor(input.issuedAt / 1000) })}`;
  // JOSE takes the raw r ‖ s, not the DER that node signs by default.
  const signature = sign('sha256', Buffer.from(unsigned), { key: input.key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}

/** The provider token in use, made again once it is 50 minutes old. */
export class ApnsToken {
  private readonly options: { teamId: string; keyId: string; key: KeyObject; now: () => number };
  private token: { jwt: string; issuedAt: number } | undefined;

  constructor(options: { teamId: string; keyId: string; key: KeyObject; now: () => number }) {
    this.options = options;
  }

  current(): string {
    const now = this.options.now();
    if (!this.token || now - this.token.issuedAt >= JWT_LIFETIME_MS) {
      this.token = { jwt: signApnsJwt({ ...this.options, issuedAt: now }), issuedAt: now };
    }
    return this.token.jwt;
  }
}

export interface ApnsClientOptions {
  teamId: string;
  keyId: string;
  /** The bundle ID of the app, sent as `apns-topic`. */
  topic: string;
  key: KeyObject;
  now: () => number;
  /** Replaces the APNs hosts. Tests point both at a local stand-in. */
  origins?: Record<ApnsEnvironment, string>;
}

/**
 * Sends pushes to APNs over HTTP/2 with token authentication (ADR 0029). One connection per environment is kept
 * open and used for every push; a closed one is replaced on the next send. It sends once: trying again is the
 * caller's decision.
 */
export class ApnsClient {
  private readonly options: ApnsClientOptions;
  private readonly tokens: ApnsToken;
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>();

  constructor(options: ApnsClientOptions) {
    this.options = options;
    this.tokens = new ApnsToken(options);
  }

  /** Resolves with APNs' answer, or rejects when no answer came (connection failure or timeout). */
  send(request: ApnsRequest): Promise<ApnsResponse> {
    return new Promise((resolve, reject) => {
      let session: ClientHttp2Session;
      try { session = this.session(request.environment); } catch (error) { reject(error); return; }
      const body = JSON.stringify(request.payload);
      const stream = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${request.token}`,
        authorization: `bearer ${this.tokens.current()}`,
        'apns-topic': this.options.topic,
        'apns-push-type': request.pushType,
        'apns-priority': request.pushType === 'alert' ? '10' : '5',
        'apns-id': request.id ?? randomUUID(),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      let status = 0;
      let text = '';
      stream.setEncoding('utf8');
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => stream.close(constants.NGHTTP2_CANCEL));
      stream.on('response', headers => { status = Number(headers[constants.HTTP2_HEADER_STATUS]); });
      stream.on('data', chunk => { text += chunk; });
      stream.on('error', reject);
      stream.on('close', () => {
        if (status === 0) { reject(new Error('no answer from APNs')); return; }
        let reason: unknown;
        try { reason = (JSON.parse(text) as { reason?: unknown }).reason; } catch { /* an empty body on success */ }
        resolve(typeof reason === 'string' ? { status, reason } : { status });
      });
      stream.end(body);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const open = this.sessions.get(environment);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect((this.options.origins ?? APNS_ORIGINS)[environment]);
    // A failed connection rejects the requests on it; the next send opens a new one.
    session.on('error', () => session.destroy());
    session.on('close', () => { if (this.sessions.get(environment) === session) this.sessions.delete(environment); });
    // The open connection alone must not keep the process running.
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }
}
