import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { ConfigError, GITHUB_CALLBACK_PATH, type ListenConfig } from './config.ts';
import type { ConnectionHub } from './connections.ts';
import type { GitHubLogin, Outcome } from './github-login.ts';
import type { SessionStore } from './sessions.ts';

const MAX_BODY_BYTES = 8 * 1024;

export interface ListenerOptions {
  listen: ListenConfig;
  tlsFiles: { cert: Buffer; key: Buffer } | undefined;
  login: GitHubLogin;
  sessions: SessionStore;
  hub: ConnectionHub;
  allowedUserId: number;
  log: (line: string) => void;
}

export interface Listener {
  address: { host: string; port: number };
  /** Serves a new certificate to new TLS connections without a restart; open connections keep theirs. */
  updateCertificate(files: { cert: Buffer; key: Buffer }): void;
  close(): Promise<void>;
}

/** The bearer token of `Authorization: Bearer <token>`, if well formed. */
export function bearerToken(request: IncomingMessage): string | undefined {
  return /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(request.headers.authorization ?? '')?.[1];
}

/** HTTPS (or loopback HTTP, as the config allows) with the login routes and the WebSocket upgrade. */
export async function openListener(options: ListenerOptions): Promise<Listener> {
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    route(request, response, options).catch(() => {
      options.log('http: internal-error');
      if (response.headersSent) response.destroy(); else json(response, 500, { error: 'internal-error' });
    });
  };
  let server: Server;
  let secure: HttpsServer | undefined;
  if (options.tlsFiles) {
    try {
      server = secure = createHttpsServer({ ...options.tlsFiles, minVersion: 'TLSv1.2' }, handle);
    } catch {
      throw new ConfigError('listen.tls', 'the certificate and key cannot be used');
    }
  } else {
    server = createHttpServer(handle);
  }
  server.on('upgrade', (request: IncomingMessage, socket, head: Buffer) => options.hub.upgrade(request, socket, head));
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => reject(new Error(`listen: cannot listen on the configured address (${error.code ?? 'error'})`));
    server.once('error', failed);
    server.listen({ host: options.listen.host, port: options.listen.port }, () => { server.off('error', failed); resolve(); });
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    address: { host: address, port },
    updateCertificate(files) {
      if (!secure) throw new Error('listen: the listener does not use TLS');
      try {
        secure.setSecureContext({ ...files, minVersion: 'TLSv1.2' });
      } catch {
        throw new ConfigError('listen.tls', 'the certificate and key cannot be used');
      }
    },
    async close() {
      await options.hub.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

async function route(request: IncomingMessage, response: ServerResponse, options: ListenerOptions) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  if (options.tlsFiles) response.setHeader('strict-transport-security', 'max-age=31536000');
  const url = new URL(request.url ?? '/', 'http://request.invalid');
  const method = request.method;

  if (method === 'GET' && url.pathname === '/auth/github/start') return answer(response, options.login.start(url.searchParams));
  if (method === 'GET' && url.pathname === GITHUB_CALLBACK_PATH) return answer(response, await options.login.callback(url.searchParams));
  if (method === 'POST' && url.pathname === '/auth/session') {
    const body = await readJson(request);
    return body === undefined ? json(response, 400, { error: 'invalid-request' }) : answer(response, options.login.redeem(body));
  }
  if (method === 'POST' && url.pathname === '/auth/logout') {
    const token = bearerToken(request);
    const session = token ? options.sessions.verify(token, options.allowedUserId) : undefined;
    if (!token || !session) return json(response, 401, { error: 'unauthorized' });
    options.sessions.revoke(token);
    options.hub.closeSession(session.sessionId);
    response.writeHead(204).end();
    return;
  }
  json(response, 404, { error: 'not-found' });
}

function answer(response: ServerResponse, outcome: Outcome) {
  if ('location' in outcome) response.writeHead(302, { location: outcome.location }).end();
  else json(response, outcome.status, outcome.body);
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
}
