import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isoAt, localDate, localIso } from './nightly.ts';
import { writeFileAtomically } from './paths.ts';
import type { SourceRegistration, Sources } from './sources.ts';
import { SOURCES_PATH } from './view.ts';

/**
 * Alertmanager's notifications as a source (ADR 0086). A sender is one Alertmanager, which POSTs a group of alerts to
 * its way in with its own bearer token. Each alert is kept by its fingerprint with the state it was last written in,
 * and a line goes into the day's file under `sources/alertmanager/<sender>/` only when that state changes: a group sent
 * again on its repeat interval, or again after an answer that was not a 2xx, writes none. `firing.jsonl` beside them
 * is what fires now, written afresh on every notification and left out of the history. An alert of a severity the
 * config marks that begins to fire is an attention, told at once.
 *
 * What is received is in the database before any file is written, and every file is written whole from it, so a
 * notification answered with a 5xx because a file could not be written has its lines written by the next one.
 */

/** The source's name, its directory under `sources/`. */
export const ALERTMANAGER_SOURCE = 'alertmanager';
/** Where the notifications are, as the workspace names it. */
export const ALERTMANAGER_PATH = `${SOURCES_PATH}/${ALERTMANAGER_SOURCE}`;
/** What fires now, in a sender's directory. */
export const FIRING_FILE = 'firing.jsonl';
/** Measured by the sender. What fires now is the day files' lines over again, so the history leaves it out. */
export const ALERTMANAGER_REGISTRATION: SourceRegistration = { name: ALERTMANAGER_SOURCE, depth: 1, exclude: [`*/${FIRING_FILE}`] };
/** A notification's body at most. Alertmanager's groups are far smaller unless something is wrong. */
export const MAX_ALERTMANAGER_BODY_BYTES = 1024 * 1024;
export const ALERTMANAGER_DEFAULTS = { attentionSeverities: ['critical'] };
/** The attention's kind, as the manual names it. */
export const ALERT_ATTENTION = 'alert';

const FILE_MODE = 0o640;
/** The label whose value is matched against `attentionSeverities`; kube-prometheus's rules name it so. */
const SEVERITY_LABEL = 'severity';
/** Alertmanager's fingerprint is 16 hex digits; anything plain is taken, since it is never a path. */
const FINGERPRINT = /^[A-Za-z0-9]{1,64}$/;

export type AlertStatus = 'firing' | 'resolved';

/** One alert of a notification, as far as natsumi reads it. */
export interface ReceivedAlert {
  status: AlertStatus;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  /** Milliseconds since the epoch. */
  startsAt: number;
  /** Only when resolved. */
  endsAt?: number;
  fingerprint: string;
  generatorURL?: string;
}

export interface AlertNotification {
  groupKey?: string;
  alerts: ReceivedAlert[];
}

/** A notification in the shape of Alertmanager's webhook (version 4), or undefined when it is not one. */
export function parseNotification(value: unknown): AlertNotification | undefined {
  if (!isRecord(value) || !Array.isArray(value.alerts)) return undefined;
  if (value.groupKey !== undefined && typeof value.groupKey !== 'string') return undefined;
  const alerts: ReceivedAlert[] = [];
  for (const item of value.alerts as unknown[]) {
    if (!isRecord(item)) return undefined;
    const { status, labels, annotations = {}, startsAt, endsAt, fingerprint, generatorURL } = item;
    if (status !== 'firing' && status !== 'resolved') return undefined;
    if (!stringMap(labels) || !stringMap(annotations)) return undefined;
    if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return undefined;
    const started = instant(startsAt);
    if (started === undefined) return undefined;
    const ended = status === 'resolved' ? instant(endsAt) : undefined;
    if (status === 'resolved' && ended === undefined) return undefined;
    if (generatorURL !== undefined && typeof generatorURL !== 'string') return undefined;
    alerts.push({ status, labels, annotations, startsAt: started, ...(ended === undefined ? {} : { endsAt: ended }), fingerprint,
      ...(generatorURL ? { generatorURL } : {}) });
  }
  return { ...(typeof value.groupKey === 'string' ? { groupKey: value.groupKey } : {}), alerts };
}

/**
 * Whether a call is a sender's own, by its name and bearer token. Every token is compared by its digest in a time
 * that does not depend on where it differs, and an unknown name against a token no call can have: a caller learns
 * nothing of which of the two was wrong.
 */
export function senderGate(tokens: ReadonlyMap<string, string>): (name: string, token: string | undefined) => boolean {
  const digests = new Map([...tokens].map(([name, token]) => [name, digest(token)]));
  const nobody = digest(`no sender ${Math.random()}`);
  return (name, token) => {
    const expected = digests.get(name);
    const matches = timingSafeEqual(digest(token ?? ''), expected ?? nobody);
    return expected !== undefined && token !== undefined && matches;
  };
}

export interface AlertmanagerInboxOptions {
  db: DatabaseSync;
  /** `sources/alertmanager` in the data directory. */
  directory: string;
  timeZone: string;
  attentionSeverities: readonly string[];
  now: () => number;
  /** Where the attentions go. Without it (the history could not be kept) the files are written all the same. */
  sources?: Pick<Sources, 'recordAttention' | 'notify'>;
  log?: (line: string) => void;
}

interface AlertRow { status: AlertStatus }

export class AlertmanagerInbox {
  private readonly options: AlertmanagerInboxOptions;
  private chain: Promise<unknown> = Promise.resolve();
  /** The day files of each sender whose lines changed and that are not yet written. */
  private readonly unwritten = new Map<string, Set<string>>();

  constructor(options: AlertmanagerInboxOptions) {
    this.options = options;
  }

  /** As the server starts: writes each sender's newest day and what fires, in case the last process could not. */
  prepare(): Promise<void> {
    return this.serialize(async () => {
      const rows = this.options.db.prepare(`SELECT sender, MAX(file_date) AS file_date FROM alertmanager_lines GROUP BY sender`)
        .all() as { sender: string; file_date: string }[];
      for (const { sender, file_date: date } of rows) this.unwrittenOf(sender).add(date);
      for (const { sender } of rows) {
        try { await this.writeFiles(sender); } catch { this.log(`the files of ${sender} could not be written`); }
      }
    });
  }

  /**
   * Takes one notification of a sender: the alerts whose state changed are lines of today's file, and every alert's
   * state and latest form are kept. Resolves once the files are written; rejects when they could not be, and what was
   * taken is then written by the next notification of that sender. Returns how many lines were written.
   */
  receive(sender: string, notification: AlertNotification): Promise<{ recorded: number }> {
    return this.serialize(async () => {
      const { db, timeZone, now, sources } = this.options;
      const at = now();
      const date = localDate(at, timeZone);
      const file = `${ALERTMANAGER_PATH}/${sender}/${date}.jsonl`;
      let recorded = 0;
      let marked = false;
      db.exec('BEGIN');
      try {
        const known = db.prepare('SELECT status FROM alertmanager_alerts WHERE sender = ? AND fingerprint = ?');
        const keep = db.prepare(`INSERT INTO alertmanager_alerts (sender, fingerprint, status, starts_at, line, updated_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sender, fingerprint)
          DO UPDATE SET status = excluded.status, starts_at = excluded.starts_at, line = excluded.line, updated_at = excluded.updated_at`);
        const count = db.prepare('SELECT COUNT(*) AS lines FROM alertmanager_lines WHERE sender = ? AND file_date = ?');
        const append = db.prepare('INSERT INTO alertmanager_lines (sender, file_date, line, created_at) VALUES (?, ?, ?, ?)');
        for (const alert of notification.alerts) {
          const line = JSON.stringify(this.line(alert, at, notification.groupKey));
          const before = known.get(sender, alert.fingerprint) as AlertRow | undefined;
          keep.run(sender, alert.fingerprint, alert.status, isoAt(alert.startsAt), line, isoAt(at));
          if (before?.status === alert.status) continue;
          const { lines } = count.get(sender, date) as { lines: number };
          append.run(sender, date, line, isoAt(at));
          recorded += 1;
          const severity = alert.labels[SEVERITY_LABEL];
          if (alert.status === 'firing' && severity !== undefined && this.options.attentionSeverities.includes(severity) && sources) {
            marked = sources.recordAttention({ source: ALERTMANAGER_SOURCE, kind: ALERT_ATTENTION, file, path: `.[${lines}]`,
              details: { ...(alert.labels.alertname ? { alertname: alert.labels.alertname } : {}), severity } }) || marked;
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (recorded > 0) this.unwrittenOf(sender).add(date);
      await this.writeFiles(sender);
      if (marked) sources?.notify();
      return { recorded };
    });
  }

  /** The day files of a sender not yet written, and what fires now. */
  private async writeFiles(sender: string): Promise<void> {
    const { db, directory } = this.options;
    const place = join(directory, sender);
    await mkdir(place, { recursive: true, mode: 0o750 });
    const unwritten = this.unwrittenOf(sender);
    for (const date of [...unwritten].sort()) {
      const lines = (db.prepare('SELECT line FROM alertmanager_lines WHERE sender = ? AND file_date = ? ORDER BY line_id')
        .all(sender, date) as { line: string }[]).map(row => row.line);
      await writeFileAtomically(join(place, `${date}.jsonl`), joinLines(lines), FILE_MODE);
      unwritten.delete(date);
    }
    const firing = (db.prepare(`SELECT line FROM alertmanager_alerts WHERE sender = ? AND status = 'firing'
      ORDER BY starts_at, fingerprint`).all(sender) as { line: string }[]).map(row => row.line);
    await writeFileAtomically(join(place, FIRING_FILE), joinLines(firing), FILE_MODE);
  }

  /**
   * One alert as its line: when it was received (natsumi's time, to the second), its state, its name and severity
   * lifted out of the labels, the labels and annotations as they came, when it began and ended, and how to find it.
   */
  private line(alert: ReceivedAlert, at: number, groupKey: string | undefined): Record<string, unknown> {
    const { alertname, [SEVERITY_LABEL]: severity } = alert.labels;
    return {
      at: this.local(at), status: alert.status, ...(alertname !== undefined ? { alertname } : {}), ...(severity !== undefined ? { severity } : {}),
      labels: alert.labels, annotations: alert.annotations, starts_at: this.local(alert.startsAt),
      ...(alert.endsAt !== undefined ? { ends_at: this.local(alert.endsAt) } : {}), fingerprint: alert.fingerprint,
      ...(alert.generatorURL ? { generator_url: alert.generatorURL } : {}), ...(groupKey ? { group_key: groupKey } : {}),
    };
  }

  /** `2026-10-30 10:00:05`, as the Slack files write their times. */
  private local(ms: number): string { return localIso(ms, this.options.timeZone).slice(0, 19).replace('T', ' '); }

  private unwrittenOf(sender: string): Set<string> {
    let dates = this.unwritten.get(sender);
    if (!dates) this.unwritten.set(sender, dates = new Set());
    return dates;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private log(line: string): void { this.options.log?.(`alertmanager: ${line}`); }
}

function joinLines(lines: string[]): string { return lines.length > 0 ? `${lines.join('\n')}\n` : ''; }

function digest(text: string): Buffer { return createHash('sha256').update(text).digest(); }

/** An RFC 3339 time as milliseconds, or undefined. */
function instant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
