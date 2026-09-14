import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export type Notification = { method: string; params: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Waiter = Pending & { matches: (event: Notification) => boolean };

export class RpcError extends Error {
  code: number;
  constructor(code: number) { super(`RPC error ${code}`); this.code = code; }
}

/** Small stdio probe transport, not the application's public websocket API. */
export class RpcClient {
  private output: Writable;
  private timeout: number;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private waiters = new Set<Waiter>();
  private notifications: Notification[] = [];
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private closed: Error | undefined;

  constructor(input: Readable, output: Writable, timeout = 30_000) {
    this.output = output;
    this.timeout = timeout;
    input.on('data', (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    input.on('end', () => this.close());
    input.on('close', () => this.close());
    input.on('error', () => this.close(new Error('Input stream failed')));
    output.on('error', () => this.close(new Error('Output stream failed')));
  }

  request(method: string, params: unknown, timeout = this.timeout): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Request timeout'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void { this.send({ method, params }); }

  waitFor(matches: (event: Notification) => boolean, timeout = this.timeout): Promise<Notification> {
    if (this.closed) return Promise.reject(this.closed);
    const index = this.notifications.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.notifications.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { matches, resolve: value => resolve(value as Notification), reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('Notification timeout'));
        }, timeout) };
      this.waiters.add(waiter);
    });
  }

  close(error = new Error('Connection closed')): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of [...this.pending.values(), ...this.waiters]) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.waiters.clear();
    this.notifications = [];
    this.buffer = '';
  }

  private send(message: unknown): void {
    if (this.closed) return;
    try { this.output.write(JSON.stringify(message) + '\n'); }
    catch { this.close(new Error('Output stream failed')); }
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) return this.close(new Error('Protocol buffer overflow'));
    let newline: number;
    while (!this.closed && (newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try { this.frame(JSON.parse(line)); }
      catch { this.close(new Error('Invalid protocol frame')); }
    }
  }

  private frame(value: unknown): void {
    const m = record(value);
    if (typeof m.method === 'string') {
      if ('id' in m) {
        this.send({ id: m.id, error: { code: -32601, message: 'Probe does not execute server requests' } });
        return;
      }
      const event = { method: m.method, params: m.params };
      for (const waiter of this.waiters) {
        if (waiter.matches(event)) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(event);
          return;
        }
      }
      this.notifications.push(event);
      if (this.notifications.length > 1024) this.close(new Error('Notification queue overflow'));
      return;
    }
    if (typeof m.id !== 'number' || (('result' in m) === ('error' in m))) throw new Error();
    const pending = this.pending.get(m.id);
    if (!pending) return;
    let error: RpcError | undefined;
    if ('error' in m) {
      const detail = record(m.error);
      if (typeof detail.code !== 'number') throw new Error();
      error = new RpcError(detail.code);
    }
    clearTimeout(pending.timer);
    this.pending.delete(m.id);
    if (error) pending.reject(error);
    else pending.resolve(m.result);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid protocol object');
  return value as Record<string, unknown>;
}
