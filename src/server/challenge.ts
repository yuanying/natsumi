import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';

export interface ChallengeListenerOptions {
  host: string;
  port: number;
  publicOrigin: string;
  /** Token → key authorization of orders in progress. */
  challenges: ReadonlyMap<string, string>;
}

export interface ChallengeListener {
  address: { host: string; port: number };
  close(): Promise<void>;
}

/**
 * The one plaintext listener allowed off loopback (ADR 0007). It answers pending HTTP-01 tokens, redirects other
 * GET/HEAD requests to publicOrigin and returns 404 for everything else. It has no route to login, the API or WebSocket.
 */
export async function openChallengeListener(options: ChallengeListenerOptions): Promise<ChallengeListener> {
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => answer(request, response, options));
  server.on('upgrade', (_request: IncomingMessage, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => reject(new Error(`listen: cannot listen on the ACME challenge port (${error.code ?? 'error'})`));
    server.once('error', failed);
    server.listen({ host: options.host, port: options.port }, () => { server.off('error', failed); resolve(); });
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    address: { host: address, port },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

function answer(request: IncomingMessage, response: ServerResponse, { publicOrigin, challenges }: ChallengeListenerOptions) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  const target = request.url ?? '/';
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(404, { 'content-type': 'text/plain' }).end();
    return;
  }
  if (target.startsWith(CHALLENGE_PREFIX)) {
    const keyAuthorization = challenges.get(target.slice(CHALLENGE_PREFIX.length));
    if (keyAuthorization === undefined) response.writeHead(404, { 'content-type': 'text/plain' }).end();
    else response.writeHead(200, { 'content-type': 'text/plain' }).end(keyAuthorization);
    return;
  }
  // The origin is always publicOrigin, never the Host header or an absolute-form target, so this cannot redirect elsewhere.
  const path = target.startsWith('/') ? target : '/';
  response.writeHead(301, { location: `${publicOrigin}${path}` }).end();
}
