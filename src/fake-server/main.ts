/**
 * A stand-in for the natsumi server, for looking at a client without GitHub, a model or real memory.
 *
 *   npm run fake-server -- [--port 8787] [--reply-delay 5] [--short]
 *
 * It listens on http://localhost only (clients allow plain http for loopback), skips GitHub by redirecting
 * `/auth/github/start` straight to `natsumi://oauth/callback`, hands out a session to anyone, and speaks enough of
 * docs/client-contract.md for the conversation: a snapshot for every `session.sync`, reads, notice checks, and a
 * reply to each message after a line of thinking. Everything it says is fictional and kept in memory only.
 */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '8787' },
  'reply-delay': { type: 'string', default: '5' },
  short: { type: 'boolean', default: false },
} });
const port = Number(values.port);
const replyDelay = Number(values['reply-delay']) * 1000;

interface Message {
  messageId: string;
  role: 'owner' | 'natsumi';
  kind: 'message' | 'reply' | 'notice';
  text: string;
  createdAt: string;
  eventId?: string;
  replyTo?: string;
  about?: string[];
  expression?: string;
}

interface ClientEnvelope {
  requestId: string;
  type: string;
  payload: Record<string, unknown>;
}

const epoch = `epoch-${Date.now()}`;
const streamId = 'stream-fake';
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const longReply = [
  'おはよう。昨日は iPhone 版の画面を考えていたところで止まってたよ。',
  'ログインと会話の画面はだいたい形になってて、残りは設定と、キーボードが出たときの見え方。メインの吹き出しは、Mac と違って最新のセリフを全部読めるようにしたいって話だった。',
  '長いときは吹き出しの中だけがスクロールして、キャラクターと入力欄は動かない。お知らせも吹き出しと同じ幅にそろえる。',
  '履歴への入り口は右上のボタンに一本化して、吹き出しからは外す。',
  '今日はこの3つを直してから、ログインと会話の画面を詰める？',
].join('\n\n');

const messages: Message[] = [
  { messageId: 'm1', role: 'owner', kind: 'message', text: 'おはよう', createdAt: ago(10), eventId: 'e1' },
  { messageId: 'n1', role: 'natsumi', kind: 'notice', text: '10 時から定例があります\n資料は共有フォルダにあります', createdAt: ago(8), about: ['e0'], expression: 'neutral' },
  { messageId: 'n2', role: 'natsumi', kind: 'notice', text: '明日は祝日です', createdAt: ago(7), about: ['e0'], expression: 'happy' },
  { messageId: 'r1', role: 'natsumi', kind: 'reply', text: values.short ? 'おはよう。今日は何から始める？' : longReply, createdAt: ago(5), eventId: 'e1', replyTo: 'm1', expression: 'happy' },
];
let unacknowledged = ['n1', 'n2'];
let readThrough: string | null = null;
let expression = 'happy';
let seq = 0;
let sent = 0;
const sockets = new Set<WebSocket>();

/** Every connection shares the one stream, the way one device would see it. */
function broadcast(type: string, payload: unknown, requestId?: string, moment = false): void {
  // A line of thinking is of the moment: it carries the number the stream is already at (ADR 0017).
  if (!moment) seq += 1;
  const text = JSON.stringify({ v: 1, epoch, streamId, seq, type, payload, ...(requestId ? { requestId } : {}) });
  for (const socket of sockets) socket.send(text);
}

/** Like the real server, every use moves the session's end thirty days out (ADR 0030). */
function sessionEnd(): string {
  return new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
}

function unreadReplies(): number {
  const read = readThrough === null ? -1 : messages.findIndex((m) => m.messageId === readThrough);
  return messages.slice(read + 1).filter((m) => m.kind === 'reply').length;
}

function answer(envelope: ClientEnvelope): void {
  const { requestId, payload } = envelope;
  switch (envelope.type) {
    case 'session.sync':
      broadcast('session.snapshot', {
        deviceId: 'device-fake', messages, pendingEvents: [], avatar: { expression },
        readThroughMessageId: readThrough, unreadReplyCount: unreadReplies(), unacknowledgedNotificationIds: unacknowledged,
        sessionExpiresAt: sessionEnd(),
      }, requestId);
      return;
    case 'conversation.read':
      readThrough = String(payload.throughMessageId);
      broadcast('command.accepted', { readThroughMessageId: readThrough, unreadReplyCount: unreadReplies() }, requestId);
      return;
    case 'notification.ack':
      unacknowledged = unacknowledged.filter((id) => id !== payload.notificationId);
      broadcast('command.accepted', { notificationId: payload.notificationId }, requestId);
      return;
    case 'conversation.send':
      converse(String(payload.text), requestId);
      return;
    default:
      broadcast('command.rejected', { code: 'unsupported' }, requestId);
  }
}

function converse(text: string, requestId: string): void {
  sent += 1;
  const messageId = `m${100 + sent}`;
  const eventId = `e${100 + sent}`;
  const own: Message = { messageId, role: 'owner', kind: 'message', text, createdAt: new Date().toISOString(), eventId };
  messages.push(own);
  broadcast('conversation.message', own);
  broadcast('command.accepted', { messageId, eventId, state: 'processing' }, requestId);
  expression = 'thinking';
  broadcast('avatar.expression', { expression });
  setTimeout(() => broadcast('conversation.thinking', { line: 'メモを読み返してる' }, undefined, true), replyDelay / 3);
  setTimeout(() => {
    const reply: Message = {
      messageId: `r${100 + sent}`, role: 'natsumi', kind: 'reply', text: `「${text}」だね。わかった。`,
      createdAt: new Date().toISOString(), eventId, replyTo: messageId, expression: 'laughing',
    };
    messages.push(reply);
    broadcast('conversation.message', reply);
    expression = 'laughing';
    broadcast('avatar.expression', { expression });
    broadcast('conversation.event.completed', { eventId, messageId, status: 'replied' });
  }, replyDelay);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  console.log(request.method, url.pathname);
  if (url.pathname === '/auth/github/start') {
    const state = encodeURIComponent(url.searchParams.get('state') ?? '');
    response.writeHead(302, { Location: `natsumi://oauth/callback?code=fake-code&state=${state}` }).end();
  } else if (url.pathname === '/auth/session' && request.method === 'POST') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token: 'fake-token', expiresAt: sessionEnd() }));
  } else if (url.pathname === '/auth/logout' && request.method === 'POST') {
    response.writeHead(204).end();
  } else {
    response.writeHead(404).end();
  }
});

new WebSocketServer({ server, path: '/v1/ws' }).on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (data) => {
    const envelope = JSON.parse(data.toString()) as ClientEnvelope;
    console.log('<-', envelope.type, JSON.stringify(envelope.payload));
    answer(envelope);
  });
});

server.listen(port, 'localhost', () => console.log(`fake natsumi server on http://localhost:${port}`));
