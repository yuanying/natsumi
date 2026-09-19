import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CertificateManager, type Certificate } from './certificates.ts';
import { openChallengeListener, type ChallengeListener } from './challenge.ts';
import { loadConfig, type ServerConfig } from './config.ts';
import { ConnectionHub } from './connections.ts';
import { initializeDataDirectory, resolveDataDirectory, STATE_DIRECTORY } from './data-directory.ts';
import { GITHUB_ENDPOINTS, GitHubLogin, type GitHubEndpoints } from './github-login.ts';
import { bearerToken, openListener, type Listener } from './http.ts';
import { acquireProcessLock, type ProcessLock } from './lock.ts';
import { MIGRATIONS } from './migrations.ts';
import { createModelRuntime } from './pi-runtime.ts';
import { preparePiState } from './pi-state.ts';
import { readSecret, readTlsFiles } from './secrets.ts';
import { SessionStore } from './sessions.ts';
import { migrate, openStateDatabase } from './state-db.ts';
import { HEARTBEAT_MS, writeStatus, type ServerStatus } from './status.ts';
import { Scheduler } from './scheduler.ts';
import { ThinkingLoop, type RotationOutcome } from './thinking-loop.ts';

const SESSION_SWEEP_MS = 30_000;

export interface StartOptions {
  config: string;
  dataDir: string | undefined;
  cwd: string;
  home: string;
  /** Where `...Env` secret references are looked up. */
  env: Record<string, string | undefined>;
  /** GitHub's endpoints. Tests point these at a local stub. */
  github?: GitHubEndpoints;
  clock?: () => number;
  /** Receives fixed event lines only: never secrets, tokens or upstream response bodies. */
  log?: (line: string) => void;
  /** ACME polling interval. Tests shorten it. */
  acme?: { pollIntervalMs?: number };
  /** Replaces the configured model route and loop limits. Tests supply a synthetic runtime and model stream here. */
  pi?: {
    runtime?: () => Promise<ModelRuntime>;
    configureSession?: (session: AgentSession) => void;
    maxModelCalls?: number;
    runTimeoutMs?: number;
  };
  /** Events kept per device stream for replay after a reconnect. */
  streamBufferSize?: number;
}

type Address = { host: string; port: number };

export interface RunningServer {
  dataDirectory: string;
  config: ServerConfig;
  schemaVersion: number;
  /** The HTTPS (or loopback HTTP) listener; undefined while ACME is still obtaining the first certificate. */
  readonly address: Address | undefined;
  /** Resolves once that listener is open. */
  listening: Promise<Address>;
  /** The plaintext ACME challenge listener; undefined without ACME. */
  readonly challengeAddress: Address | undefined;
  /** Closes connections whose session has expired (also runs periodically). */
  expireSessions(): void;
  /** Obtains or renews the ACME certificate when due and serves it (also runs periodically). Nothing to do without ACME. */
  checkCertificate(): Promise<void>;
  /** Runs the nightly session switch now, as the schedule would. For operation checks. */
  rotateSession(): Promise<RotationOutcome>;
  stop(): Promise<void>;
}

/**
 * Config and secrets → data directory → lock → migration → Pi state → authenticated listener.
 * No listener opens without GitHub authentication in front of it; the ACME challenge listener has no route to it.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const config = await loadConfig(resolve(options.cwd, options.config));
  const clientSecret = await readSecret(config.github.clientSecret, 'github.clientSecret', options.env);
  const tls = config.listen.tls;
  const tlsFiles = tls && 'certFile' in tls ? await readTlsFiles(tls, 'listen.tls') : undefined;
  const now = options.clock ?? Date.now;
  const log = options.log ?? (() => {});
  const dataDirectory = await resolveDataDirectory(options.dataDir, options.cwd);
  await initializeDataDirectory(dataDirectory);
  const lock = acquireProcessLock(dataDirectory);
  let db: DatabaseSync | undefined;
  let hub: ConnectionHub | undefined;
  let loop: ThinkingLoop | undefined;
  let listener: Listener | undefined;
  let challenge: ChallengeListener | undefined;
  let certificates: CertificateManager | undefined;
  let scheduler: Scheduler | undefined;
  const timers: NodeJS.Timeout[] = [];
  // Everything opened above, closed in the reverse order.
  const closeAll = async () => {
    timers.forEach(clearInterval); // The status heartbeat and the session sweep: nothing else waits on them.
    scheduler?.stop(); // Before the listener, so no self-check, ping or nightly switch starts a turn on the way out.
    await certificates?.close(); // Abandons an ACME order in flight: no certificate arrives at a listener being closed.
    try {
      if (listener) await listener.close(); else await hub?.close(); // Stops serving clients; closing the listener closes the hub with it.
    } finally {
      // The challenge listener answers an order that is already abandoned, so it goes next; the loop is last because
      // a turn in flight still needs its Pi session, and closing it ends that turn rather than cutting it off.
      try { await challenge?.close(); } finally { await loop?.close(); }
    }
  };
  try {
    db = openStateDatabase(join(dataDirectory, STATE_DIRECTORY, 'state.sqlite'));
    const { version } = migrate(db, MIGRATIONS);
    await preparePiState(config.pi, { dataDirectory, home: options.home });

    // A missing login or a lost session leaves the loop unavailable; the server still starts so clients can see why.
    const thinkingLoop = loop = await ThinkingLoop.open({
      db, dataDirectory, sessionDirectory: config.pi.sessionDirectory, agentDirectory: config.pi.agentDirectory,
      target: { provider: config.pi.model.provider, model: config.pi.model.id }, thinking: config.pi.thinking,
      runtime: options.pi?.runtime ?? (async () => (await createModelRuntime(config.pi, options.env)).runtime),
      configureSession: options.pi?.configureSession, maxModelCalls: options.pi?.maxModelCalls,
      runTimeoutMs: options.pi?.runTimeoutMs, now, log, loop: config.loop,
    });

    // The nightly switch (ADR 0009), self-checks natsumi booked, pings in quiet moments and expressions
    // returning to neutral (ADR 0014). A night missed while stopped is caught up on the first tick.
    if (!thinkingLoop.unavailable) {
      scheduler = new Scheduler({
        loop: thinkingLoop, now, log, timeZone: config.loop.timeZone, awakeHours: config.loop.awakeHours,
        nightlyRotationAt: config.loop.nightlyRotationAt, pingIntervalMinutes: config.loop.pingIntervalMinutes,
        expressionResetMinutes: config.loop.expressionResetMinutes,
      });
      scheduler.start();
    }

    const sessions = new SessionStore(db, now);
    const allowedUserId = config.github.allowedUserId;
    const connections = hub = new ConnectionHub({
      publicOrigin: config.publicOrigin, now, db, loop: thinkingLoop, streamBufferSize: options.streamBufferSize,
      authenticate: request => {
        const token = bearerToken(request);
        return token ? sessions.verify(token, allowedUserId) : undefined;
      },
    });
    const login = new GitHubLogin({ config: config.github, clientSecret, endpoints: options.github ?? GITHUB_ENDPOINTS, sessions, now, log });
    const open = (files: { cert: Buffer; key: Buffer } | undefined) =>
      openListener({ listen: config.listen, tlsFiles: files, login, sessions, hub: connections, allowedUserId, log });

    const started = new Date().toISOString();
    const status: ServerStatus = { state: 'running', pid: process.pid, startedAt: started, updatedAt: started, schemaVersion: version };
    let opened!: (address: Address) => void;
    const listening = new Promise<Address>(resolve => { opened = resolve; });

    // All the certificate manager asks of the server: put a new certificate into the running listener,
    // or open HTTPS with the first one. When it opens is what `status.state` follows.
    const serve = async (certificate: Certificate) => {
      const files = { cert: certificate.cert, key: certificate.key };
      if (listener) return listener.updateCertificate(files);
      listener = await open(files);
      status.state = 'running';
      await writeStatus(dataDirectory, { ...status, updatedAt: new Date().toISOString() }).catch(() => {});
      log('listen: HTTPS is open');
      opened(listener.address);
    };

    if (tls && 'acme' in tls) {
      certificates = await CertificateManager.open({
        stateDirectory: join(dataDirectory, STATE_DIRECTORY), hostname: new URL(config.publicOrigin).hostname,
        acme: tls.acme, now, log, pollIntervalMs: options.acme?.pollIntervalMs,
      });
      challenge = await openChallengeListener({
        host: config.listen.host, port: tls.acme.httpPort, publicOrigin: config.publicOrigin, challenges: certificates.challenges,
      });
      // Without a certificate HTTPS stays closed: no self-signed stand-in (ADR 0007).
      if (!certificates.current) status.state = 'waiting-for-certificate';
      await certificates.start(serve);
    } else {
      listener = await open(tlsFiles);
      opened(listener.address);
    }

    const manager = certificates;
    await writeStatus(dataDirectory, status);
    timers.push(setInterval(() => {
      void writeStatus(dataDirectory, { ...status, updatedAt: new Date().toISOString() }).catch(() => {});
    }, HEARTBEAT_MS));
    timers.push(setInterval(() => connections.expireSessions(), SESSION_SWEEP_MS));

    let stopping: Promise<void> | undefined;
    const database = db;
    return {
      dataDirectory, config, schemaVersion: version, listening,
      get address() { return listener?.address; },
      get challengeAddress() { return challenge?.address; },
      expireSessions: () => connections.expireSessions(),
      checkCertificate: () => manager?.checkCertificate() ?? Promise.resolve(),
      rotateSession: () => thinkingLoop.rotate(),
      stop() {
        stopping ??= (async () => {
          try {
            await closeAll();
            await writeStatus(dataDirectory, { ...status, state: 'stopped', updatedAt: new Date().toISOString() });
          } finally { shutdown(database, lock); }
        })();
        return stopping;
      },
    };
  } catch (error) {
    try { await closeAll(); } finally { shutdown(db, lock); }
    throw error;
  }
}

function shutdown(db: DatabaseSync | undefined, lock: ProcessLock) {
  try { db?.close(); } finally { lock.release(); }
}
