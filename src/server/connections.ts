import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { DEFAULT_STREAM_BUFFER_SIZE, DeviceStreams, EventStream, PROTOCOL_VERSION } from './device-streams.ts';
import type { VerifiedSession } from './sessions.ts';
import type { ThinkingLoop } from './thinking-loop.ts';

export { PROTOCOL_VERSION };
export const WEBSOCKET_PATH = '/v1/ws';
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
/** A client this far behind is disconnected; it reconnects and syncs, falling back to a snapshot. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const CLOSE_DEVICE_REPLACED = 4001;
export const CLOSE_TOO_SLOW = 4002;

/** Commands of the v1 client contract. The ones not handled below receive a safe rejection. */
const KNOWN_COMMANDS = new Set(['session.sync', 'conversation.send', 'conversation.read', 'conversation.interrupt', 'approval.decide',
  'notification.ack', 'device.activity']);

interface Connection {
  session: VerifiedSession;
  expiresAt: number;
  /** Answers sent before `session.sync` binds the connection to a device stream. */
  local: EventStream;
  deliver: (text: string) => void;
  deviceId?: string;
  stream?: EventStream;
}

export interface ConnectionHubOptions {
  publicOrigin: string;
  /** The live session presented by an upgrade request, or undefined. */
  authenticate: (request: IncomingMessage) => VerifiedSession | undefined;
  now: () => number;
  db: DatabaseSync;
  loop: ThinkingLoop;
  /** Events kept per device stream for replay after a reconnect. */
  streamBufferSize?: number;
}

type Payload = Record<string, unknown>;
const isObject = (value: unknown): value is Payload => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Authenticated WebSocket connections. Every check happens during the HTTP upgrade, so a refused client never
 * gets an open connection. `session.sync` binds a connection to a server-registered device and its stream.
 */
export class ConnectionHub {
  readonly epoch = randomUUID();
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly options: ConnectionHubOptions;
  private readonly devices: DeviceStreams;
  private readonly unsubscribe: () => void;

  constructor(options: ConnectionHubOptions) {
    this.options = options;
    this.devices = new DeviceStreams(options.db, this.epoch, options.streamBufferSize ?? DEFAULT_STREAM_BUFFER_SIZE);
    // Everything the loop shows the owner goes to every device alike. An event of the moment (the line of thinking)
    // reaches whoever is connected without taking a number or being kept for replay (ADR 0017).
    this.unsubscribe = options.loop.subscribe(event => {
      if (event.ephemeral) this.devices.broadcastEphemeral(event.type, event.payload);
      else this.devices.broadcast(event.type, event.payload);
    });
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
    for (const [ws, connection] of this.connections) if (connection.session.sessionId === sessionId) ws.close(1008, 'session ended');
  }

  /** Closes connections whose session has expired. Called periodically and before every command. */
  expireSessions(): void {
    const now = this.options.now();
    for (const [ws, connection] of this.connections) if (connection.expiresAt <= now) ws.close(1008, 'session ended');
  }

  close(): Promise<void> {
    this.unsubscribe();
    for (const ws of this.connections.keys()) ws.terminate();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private accept(ws: WebSocket, session: VerifiedSession) {
    const deliver = (text: string) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.close(CLOSE_TOO_SLOW, 'too far behind; sync again'); return; }
      ws.send(text);
    };
    const local = new EventStream(this.epoch, 0);
    local.sink = deliver;
    const connection: Connection = { session, expiresAt: Date.parse(session.expiresAt), local, deliver };
    this.connections.set(ws, connection);
    ws.on('close', () => {
      this.connections.delete(ws);
      // Events keep numbering on the device stream while nobody receives them.
      if (connection.stream?.sink === deliver) connection.stream.sink = undefined;
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (data, isBinary) => this.receive(ws, connection, data, isBinary));
  }

  private receive(ws: WebSocket, connection: Connection, data: RawData, isBinary: boolean) {
    if (connection.expiresAt <= this.options.now()) { ws.close(1008, 'session ended'); return; }
    const out = () => connection.stream ?? connection.local;
    let envelope: unknown;
    try { if (!isBinary) envelope = JSON.parse(String(data)); } catch { /* handled below */ }
    if (!isObject(envelope)) {
      out().publish('command.rejected', { code: 'invalid-envelope' });
      ws.close(1007, 'invalid envelope');
      return;
    }
    const { v, type, requestId, deviceId } = envelope;
    const id = typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128 ? requestId : undefined;
    if (v !== PROTOCOL_VERSION) {
      out().publish('command.rejected', { code: 'unsupported-version' }, id);
      ws.close(1002, 'unsupported protocol version');
      return;
    }
    // Unknown types are ignored so newer clients keep working. deviceId is never treated as authentication.
    if (typeof type !== 'string' || !KNOWN_COMMANDS.has(type)) return;
    const payload = isObject(envelope.payload) ? envelope.payload : {};
    const reject = (code: string) => out().publish('command.rejected', { code }, id);

    if (type === 'session.sync') return this.sync(ws, connection, deviceId, payload, id);
    if (type === 'conversation.send' || type === 'conversation.read' || type === 'notification.ack') {
      if (!connection.stream || !connection.deviceId) return reject('sync-required');
      if (deviceId !== connection.deviceId) return reject('device-mismatch');
    }
    const { stream } = connection;
    switch (type) {
      case 'conversation.send':
        if (id === undefined) return reject('invalid-request');
        return this.send(stream!, connection.deviceId!, payload, id);
      case 'conversation.read': {
        const { throughMessageId } = payload;
        if (!isId(throughMessageId)) return reject('invalid-request');
        return answer(stream!, this.options.loop.markRead({ throughMessageId, deviceId: connection.deviceId! }), id);
      }
      case 'notification.ack': {
        // A notification is a notice in the conversation; its ID is the notice's messageId (ADR 0013).
        const { notificationId } = payload;
        if (!isId(notificationId)) return reject('invalid-request');
        return answer(stream!, this.options.loop.acknowledgeNotice({ notificationId, deviceId: connection.deviceId! }), id);
      }
      default:
        // conversation.interrupt among them: a thought in progress is never stopped from outside (ADR 0008).
        return reject('not-implemented');
    }
  }

  private sync(ws: WebSocket, connection: Connection, requested: unknown, payload: Payload, requestId: string | undefined) {
    if (connection.deviceId && requested !== connection.deviceId) {
      connection.stream!.publish('command.rejected', { code: 'device-mismatch' }, requestId);
      return;
    }
    const { session } = connection;
    const deviceId = this.devices.register(requested, session.githubUserId, session.sessionId);
    const stream = this.devices.stream(deviceId);
    for (const [other, otherConnection] of this.connections) {
      if (other === ws || otherConnection.deviceId !== deviceId) continue;
      otherConnection.deviceId = undefined;
      otherConnection.stream = undefined;
      other.close(CLOSE_DEVICE_REPLACED, 'replaced by a newer connection of this device');
    }
    connection.deviceId = deviceId;
    connection.stream = stream;
    stream.sink = connection.deliver;

    const { loop } = this.options;
    if (loop.unavailable) {
      stream.publish('service.unavailable', { code: loop.unavailable, deviceId }, requestId);
      return;
    }
    const resume = isObject(payload.resume) ? payload.resume : undefined;
    if (resume && resume.epoch === this.epoch && resume.streamId === stream.streamId) {
      const missed = stream.replayAfter(resume.seq);
      if (missed) {
        for (const text of missed) connection.deliver(text);
        stream.publish('command.accepted', { deviceId, mode: 'resume' }, requestId);
        return;
      }
    }
    // A different epoch or stream, a gap, or events already gone from the buffer: start over from a snapshot.
    // Its own seq is the barrier; events numbered after it apply on top.
    stream.publish('session.snapshot', { deviceId, ...loop.snapshot() }, requestId);
  }

  private send(stream: EventStream, deviceId: string, payload: Payload, requestId: string) {
    const { text } = payload;
    if (typeof text !== 'string' || text.trim() === '' || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      stream.publish('command.rejected', { code: 'invalid-request' }, requestId);
      return;
    }
    const outcome = this.options.loop.send({ requestId, deviceId, text });
    if (outcome.kind === 'unavailable') {
      stream.publish('service.unavailable', { code: outcome.code }, requestId);
    } else if (outcome.kind === 'rejected') {
      stream.publish('command.rejected', { code: outcome.code }, requestId);
    } else {
      // The message is already recorded; the loop's own events follow this answer.
      stream.publish('command.accepted', { messageId: outcome.messageId, eventId: outcome.eventId, state: outcome.state }, requestId);
    }
  }
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Sends the loop's outcome of a read or an acknowledgement to the device that asked. */
function answer(stream: EventStream, outcome: { kind: 'accepted' | 'rejected' | 'unavailable'; code?: string }, requestId: string | undefined) {
  const { kind, ...result } = outcome;
  if (kind === 'accepted') stream.publish('command.accepted', result, requestId);
  else stream.publish(kind === 'rejected' ? 'command.rejected' : 'service.unavailable', { code: result.code }, requestId);
}

function refuse(socket: Duplex, status: number, code: string) {
  const body = JSON.stringify({ error: code });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: application/json\r\n`
    + `Cache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
