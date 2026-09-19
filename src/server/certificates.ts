import { createHash, createPrivateKey, generateKeyPairSync, X509Certificate, type KeyObject } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AcmeError, CERTIFICATE_PEM, issueCertificate } from './acme.ts';
import type { AcmeConfig } from './config.ts';
import { writeFileAtomically } from './paths.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Renew when this much validity is left, or a third of the lifetime for short-lived certificates. */
export const RENEW_BEFORE_MS = 30 * DAY;
/** Background checks run at least this often. */
export const CHECK_INTERVAL_MS = 12 * HOUR;
const RETRY_FIRST_MS = 15 * MINUTE;
const RETRY_MAX_MS = 12 * HOUR;
/** The shortest wait between background checks, so a schedule surprise cannot spin. */
const MIN_CHECK_MS = 60_000;

const PRIVATE_KEY_PEM = /-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+?-----END PRIVATE KEY-----/;

export interface Certificate { cert: Buffer; key: Buffer; notBefore: number; notAfter: number }

export interface CertificateManagerOptions {
  /** `.natsumi` in the data directory. */
  stateDirectory: string;
  hostname: string;
  acme: AcmeConfig;
  now: () => number;
  log: (line: string) => void;
  pollIntervalMs?: number;
}

/**
 * The ACME account key and the certificate for one host, kept in `.natsumi/acme/<CA>/` (directories 0700, files 0600).
 * A stored certificate is reused across restarts until it is due; a failed renewal keeps it and backs off.
 * Once started it owns the whole state of a certificate: when to look, when to retry, and handing each new one over.
 */
export class CertificateManager {
  /** Pending HTTP-01 answers, for the plaintext listener. */
  readonly challenges = new Map<string, string>();
  current: Certificate | undefined;
  private readonly options: CertificateManagerOptions;
  private readonly file: string;
  private readonly accountKey: KeyObject;
  private readonly aborter = new AbortController();
  private failures = 0;
  private retryAt = 0;
  /** Set by `start`: what a new certificate is handed to. */
  private onCertificate: ((certificate: Certificate) => Promise<void>) | undefined;
  /** The certificate already handed over, so the same one never goes twice. */
  private served: Certificate | undefined;
  private checking: Promise<void> | undefined;
  private renewal: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(options: CertificateManagerOptions, file: string, accountKey: KeyObject) {
    this.options = options;
    this.file = file;
    this.accountKey = accountKey;
  }

  static async open(options: CertificateManagerOptions): Promise<CertificateManager> {
    // One area per CA: an account belongs to its directory, and a staging certificate is never served as production.
    const ca = createHash('sha256').update(options.acme.directoryUrl).digest('hex').slice(0, 16);
    const directory = join(options.stateDirectory, 'acme', ca);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manager = new CertificateManager(options, join(directory, `${options.hostname}.pem`), await loadAccountKey(join(directory, 'account-key.pem')));
    manager.current = await manager.load();
    return manager;
  }

  /**
   * Hands over a stored certificate, then keeps one: a check now, and another whenever the next one is due or a
   * back-off ends. Nothing is handed over before this is awaited, so the caller decides the state it starts in.
   */
  async start(onCertificate: (certificate: Certificate) => Promise<void>): Promise<void> {
    this.onCertificate = onCertificate;
    if (this.current) await this.hand(this.current);
    this.background();
  }

  /**
   * Obtains or renews the certificate when due and hands over what comes back. Concurrent callers join the check
   * in flight rather than starting a second order. Called by the background timer and for an operation check.
   */
  checkCertificate(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.checking ??= (async () => {
      await this.obtain();
      if (this.current && this.current !== this.served && !this.closed) await this.hand(this.current);
    })().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  /** Stops the background checks, abandons an order in progress and waits for the check in flight. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.renewal);
    this.aborter.abort();
    await this.checking?.catch(() => {});
  }

  /** When a check next has work to do: the renewal time, or the end of a failure's back-off. */
  private nextCheckAt(): number {
    return Math.max(this.current ? renewalTime(this.current) : 0, this.retryAt);
  }

  private async hand(certificate: Certificate): Promise<void> {
    await this.onCertificate?.(certificate);
    this.served = certificate;
  }

  /** A check whose failure only gets logged, and which books the one after it. */
  private background(): void {
    if (this.closed) return;
    void this.checkCertificate().catch(error => {
      this.options.log(`acme: the certificate could not be served (${(error as NodeJS.ErrnoException).code ?? (error as Error).name ?? 'error'})`);
    }).finally(() => {
      if (this.closed) return;
      const wait = Math.min(Math.max(this.nextCheckAt() - this.options.now(), MIN_CHECK_MS), CHECK_INTERVAL_MS);
      this.renewal = setTimeout(() => this.background(), wait);
    });
  }

  /** Obtains a certificate when there is none or the current one is due, unless a back-off is running. True when one was obtained. */
  private async obtain(): Promise<boolean> {
    const now = this.options.now();
    if (now < this.retryAt || (this.current && now < renewalTime(this.current))) return false;
    const { log, acme, hostname } = this.options;
    log(this.current ? 'acme: renewing the certificate' : 'acme: requesting a certificate');
    try {
      const issued = await issueCertificate({
        directoryUrl: acme.directoryUrl, accountKey: this.accountKey, contactEmail: acme.contactEmail, hostname,
        challenges: this.challenges, signal: this.aborter.signal, pollIntervalMs: this.options.pollIntervalMs,
      });
      const pem = `${issued.privateKeyPem.trim()}\n${issued.certificatePem}`;
      const certificate = parseCertificate(pem, hostname);
      await writeFileAtomically(this.file, pem, 0o600);
      this.current = certificate;
      this.failures = 0;
      this.retryAt = 0;
      log('acme: certificate issued');
      return true;
    } catch (error) {
      if (this.aborter.signal.aborted) return false;
      this.failures += 1;
      const wait = Math.min(RETRY_FIRST_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
      this.retryAt = this.options.now() + wait;
      const reason = error instanceof AcmeError ? error.message : 'acme: the certificate could not be stored or used';
      log(`${reason}; ${this.current ? 'keeping the current certificate; ' : ''}retrying in ${Math.round(wait / MINUTE)} minutes`);
      return false;
    }
  }

  private async load(): Promise<Certificate | undefined> {
    let pem: string;
    try { pem = await readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('acme: the stored certificate cannot be read');
    }
    try {
      const certificate = parseCertificate(pem, this.options.hostname);
      if (certificate.notAfter <= this.options.now()) throw new Error('expired');
      this.options.log('acme: using the stored certificate');
      return certificate;
    } catch {
      this.options.log('acme: the stored certificate is not usable; a new one will be requested');
      return undefined;
    }
  }
}

function renewalTime(certificate: Certificate): number {
  return certificate.notAfter - Math.min(RENEW_BEFORE_MS, (certificate.notAfter - certificate.notBefore) / 3);
}

/** A stored or issued PEM: the private key, then the chain. The leaf must name the host and match the key. */
function parseCertificate(pem: string, hostname: string): Certificate {
  const key = PRIVATE_KEY_PEM.exec(pem)?.[0];
  const chain = pem.match(CERTIFICATE_PEM);
  if (!key || !chain?.[0]) throw new Error('incomplete');
  const leaf = new X509Certificate(chain[0]);
  if (leaf.checkHost(hostname) === undefined || !leaf.checkPrivateKey(createPrivateKey(key))) throw new Error('mismatch');
  return {
    cert: Buffer.from(`${chain.join('\n')}\n`), key: Buffer.from(`${key}\n`),
    notBefore: Date.parse(leaf.validFrom), notAfter: Date.parse(leaf.validTo),
  };
}

/** The account key is created once and reused; an unreadable one stops startup rather than silently opening a new account. */
async function loadAccountKey(file: string): Promise<KeyObject> {
  try { return createPrivateKey(await readFile(file, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('acme: the stored account key cannot be used');
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  try {
    await writeFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadAccountKey(file);
    throw new Error('acme: the account key cannot be stored');
  }
  return privateKey;
}
