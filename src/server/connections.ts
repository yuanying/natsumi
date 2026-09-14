import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { VerifiedSession } from './sessions.ts';

export const PROTOCOL_VERSION = 1;
export const WEBSOCKET_PATH = '/v1/ws';
const MAX_MESSAGE_BYTES = 64 * 1024;

/** Commands of the v1 client contract. None is implemented yet; each receives a safe rejection. */
const KNOWN_COMMANDS = new Set(['session.sync', 'conversation.send', 'conversation.interrupt', 'approval.decide', 'notification.ack', 'device.activity']);

interface Connection { sessionId: string; expiresAt: number; streamId: string; seq: number }

export interface ConnectionHubOptions {
  publicOrigin: string;
  /** The live session presented by an upgrade request, or undefined. */
  authenticate: (request: IncomingMessage) => VerifiedSession | undefined;
  now: () => number;
}

/**
 * Authenticated WebSocket connections. Every check happens during the HTTP upgrade, so a refused client never
 * gets an open connection. Until device registration exists each connection is its own stream.
 */
export class ConnectionHub {
  readonly epoch = randomUUID();
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly options: ConnectionHubOptions;

  constructor(options: ConnectionHubOptions) {
    this.options = options;
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const path = new URL(request.url ?? '/', 'http://upgrade.invalid').pathname;
    if (path !== WEBSOCKET_PATH) return refuse(socket, 404, 'not-found');
    // Browsers always send Origin; native clients may omit it. A present Origin must be ours.
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== this.options.publicOrigin) return refuse(socket, 403, 'origin-not-allowed');
    const session = this.options.authenticate(request);
    if (!session) return refuse(socket, 401, 'unauthorized');
    this.server.handleUpgrade(request, socket, head, ws => this.accept(ws, session));
  }

  /** Closes every connection opened with this session (logout). */
  closeSession(sessionId: string): void {
    for (const [ws, connection] of this.connections) if (connection.sessionId === sessionId) ws.close(1008, 'session ended');
  }

  /** Closes connections whose session has expired. Called periodically. */
  expireSessions(): void {
    const now = this.options.now();
    for (const [ws, connection] of this.connections) if (connection.expiresAt <= now) ws.close(1008, 'session ended');
  }

  close(): Promise<void> {
    for (const ws of this.connections.keys()) ws.terminate();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private accept(ws: WebSocket, session: VerifiedSession) {
    const connection: Connection = { sessionId: session.sessionId, expiresAt: Date.parse(session.expiresAt), streamId: randomUUID(), seq: 0 };
    this.connections.set(ws, connection);
    ws.on('close', () => this.connections.delete(ws));
    ws.on('error', () => ws.terminate());
    ws.on('message', (data, isBinary) => this.receive(ws, connection, data, isBinary));
  }

  private receive(ws: WebSocket, connection: Connection, data: RawData, isBinary: boolean) {
    let envelope: unknown;
    try { if (!isBinary) envelope = JSON.parse(String(data)); } catch { /* handled below */ }
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      this.send(ws, connection, 'command.rejected', undefined, { code: 'invalid-envelope' });
      ws.close(1007, 'invalid envelope');
      return;
    }
    const { v, type, requestId } = envelope as Record<string, unknown>;
    const id = typeof requestId === 'string' && requestId.length <= 128 ? requestId : undefined;
    if (v !== PROTOCOL_VERSION) {
      this.send(ws, connection, 'command.rejected', id, { code: 'unsupported-version' });
      ws.close(1002, 'unsupported protocol version');
      return;
    }
    // Unknown types are ignored so newer clients keep working. deviceId is never treated as authentication.
    if (typeof type !== 'string' || !KNOWN_COMMANDS.has(type)) return;
    this.send(ws, connection, 'command.rejected', id, { code: 'not-implemented' });
  }

  private send(ws: WebSocket, connection: Connection, type: string, requestId: string | undefined, payload: Record<string, unknown>) {
    connection.seq += 1;
    ws.send(JSON.stringify({
      v: PROTOCOL_VERSION, epoch: this.epoch, streamId: connection.streamId, seq: connection.seq, type,
      ...(requestId === undefined ? {} : { requestId }), payload,
    }));
  }
}

function refuse(socket: Duplex, status: number, code: string) {
  const body = JSON.stringify({ error: code });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: application/json\r\n`
    + `Cache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
