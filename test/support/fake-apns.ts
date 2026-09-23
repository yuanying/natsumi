import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type Http2Server, type Http2Session, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';

export interface ReceivedPush { headers: IncomingHttpHeaders; body: Record<string, any> }
export interface FakeAnswer { status: number; reason?: string }

/** A throwaway APNs signing key, as the .p8 file holds it (PKCS#8 PEM). Made per test run; never a real key. */
export function apnsTestKey(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
}

/**
 * A local stand-in for APNs over cleartext HTTP/2. It records every request and answers with the queued answers
 * in order, then 200.
 */
export class FakeApns {
  readonly received: ReceivedPush[] = [];
  readonly answers: FakeAnswer[] = [];
  /** Connections opened to this server, counted to see that the client reuses one. */
  readonly sessions = new Set<Http2Session>();
  connections = 0;
  private server!: Http2Server;
  origin = '';

  async start() {
    this.server = createServer();
    this.server.on('session', session => {
      this.connections += 1;
      this.sessions.add(session);
      session.on('close', () => this.sessions.delete(session));
    });
    this.server.on('stream', (stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => { body += chunk; });
      stream.on('end', () => {
        this.received.push({ headers, body: JSON.parse(body) });
        const answer = this.answers.shift() ?? { status: 200 };
        const apnsId = headers['apns-id'] ?? 'fake-apns-id';
        stream.respond({ ':status': answer.status, 'apns-id': apnsId, 'content-type': 'application/json' });
        stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : '');
      });
    });
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  /** Waits until at least `count` requests arrived. */
  async waitFor(count: number, timeout = 5_000): Promise<ReceivedPush[]> {
    const deadline = Date.now() + timeout;
    while (this.received.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out; received ${this.received.length} of ${count}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return this.received;
  }

  close() {
    for (const session of this.sessions) session.destroy();
    return new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
