import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SdkA2AClient } from './a2a-client.ts';
import { AGENT_LIST_DIRECTORY, writeAgentList } from './agent-list.ts';
import { ApnsClient, parseApnsKey, type ApnsEnvironment } from './apns.ts';
import { CertificateManager, type Certificate } from './certificates.ts';
import { openChallengeListener, type ChallengeListener } from './challenge.ts';
import { ConfigError, loadConfig, type ServerConfig } from './config.ts';
import { ConnectionHub } from './connections.ts';
import { initializeDataDirectory, resolveDataDirectory, STATE_DIRECTORY } from './data-directory.ts';
import { GITHUB_ENDPOINTS, GitHubLogin, type GitHubEndpoints } from './github-login.ts';
import { bearerToken, openListener, type Listener } from './http.ts';
import { acquireProcessLock, type ProcessLock } from './lock.ts';
import { MIGRATIONS } from './migrations.ts';
import { isoAt } from './nightly.ts';
import { createModelRuntime } from './pi-runtime.ts';
import { preparePiState } from './pi-state.ts';
import { parseRegistration, PushNotifier, PushRegistrations } from './push.ts';
import { readSecret, readTlsFiles } from './secrets.ts';
import { SessionStore } from './sessions.ts';
import { SLACK_SOURCE, SlackArchive } from './slack-archive.ts';
import { connectSlack, type SlackConnector } from './slack-api.ts';
import { SlackWorkspace } from './slack.ts';
import { SOURCES_DIRECTORY } from './paths.ts';
import type { UpdateSource } from './updates.ts';
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
  /** Replaces the configured model route. Tests supply a synthetic runtime and model stream here. */
  pi?: {
    runtime?: () => Promise<ModelRuntime>;
    configureSession?: (session: AgentSession) => void;
  };
  /** Events kept per device stream for replay after a reconnect. */
  streamBufferSize?: number;
  /** Replaces the APNs hosts and the waits between tries. Tests point them at a local stand-in. */
  apns?: { origins?: Record<ApnsEnvironment, string>; retryDelaysMs?: number[] };
  /** Replaces `a2a.pollIntervalSeconds`, whose floor is too long for a test. */
  a2a?: { pollIntervalMs?: number };
  /** Replaces the Slack SDKs. Tests hand in a stand-in for the Web API and Socket Mode. */
  slack?: { connector?: SlackConnector };
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
  // A key that cannot sign stops startup here, not at the first push.
  const apnsKey = config.apns ? parseApnsKey(await readSecret(config.apns.key, 'apns.key', options.env)) : undefined;
  if (config.apns && !apnsKey) {
    throw new ConfigError('file' in config.apns.key ? 'apns.keyFile' : 'apns.keyEnv',
      'the referenced key is not an EC P-256 private key in PEM (the .p8 file)');
  }
  // Every token is read now, so a missing one stops startup with its setting's name rather than failing later.
  const slackTokens = config.slack ? await Promise.all(Object.entries(config.slack.workspaces).map(async ([name, workspace]) => ({
    name,
    botToken: await readSecret(workspace.botToken, `slack.workspaces.${name}.botToken`, options.env),
    appToken: await readSecret(workspace.appToken, `slack.workspaces.${name}.appToken`, options.env),
  }))) : [];
  const tls = config.listen.tls;
  const tlsFiles = tls && 'certFile' in tls ? await readTlsFiles(tls, 'listen.tls') : undefined;
  const now = options.clock ?? Date.now;
  const log = options.log ?? (() => {});
  const dataDirectory = await resolveDataDirectory(options.dataDir, options.cwd);
  await initializeDataDirectory(dataDirectory);
  const lock = acquireProcessLock(dataDirectory);
  let db: DatabaseSync | undefined;
  let hub: ConnectionHub | undefined;
  let notifier: PushNotifier | undefined;
  let apns: ApnsClient | undefined;
  let loop: ThinkingLoop | undefined;
  let listener: Listener | undefined;
  let challenge: ChallengeListener | undefined;
  let certificates: CertificateManager | undefined;
  let scheduler: Scheduler | undefined;
  const slackWorkspaces: SlackWorkspace[] = [];
  const timers: NodeJS.Timeout[] = [];
  // Everything opened above, closed in the reverse order.
  const closeAll = async () => {
    timers.forEach(clearInterval); // The status heartbeat and the session sweep: nothing else waits on them.
    scheduler?.stop(); // Before the listener, so no self-check, ping or nightly switch starts a turn on the way out.
    await Promise.all(slackWorkspaces.map(workspace => workspace.stop())); // Before the loop: no new mention is raised into it.
    notifier?.close(); // Drops the pushes waiting to be tried again: they are kept in memory only (ADR 0029).
    apns?.close();
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

    // One client for the loop and the list: the token file is read afresh on every call either makes (ADR 0033).
    const a2aClient = config.a2a ? new SdkA2AClient({ tokenFile: config.a2a.tokenFile }) : undefined;
    // What she reads of Slack, written under sources/slack whether or not it is counted in the updates (ADR 0039).
    const slackConfig = config.slack;
    const archive = slackConfig ? new SlackArchive({ db, directory: join(dataDirectory, SOURCES_DIRECTORY, SLACK_SOURCE),
      timeZone: config.loop.timeZone, now, mentionContext: slackConfig.mentionContext }) : undefined;
    await archive?.prepare();
    const updates: UpdateSource[] = archive && slackConfig?.updates ? [archive] : [];

    // A missing login or a lost session leaves the loop unavailable; the server still starts so clients can see why.
    const thinkingLoop = loop = await ThinkingLoop.open({
      db, dataDirectory, sessionDirectory: config.pi.sessionDirectory, agentDirectory: config.pi.agentDirectory,
      target: { provider: config.pi.model.provider, model: config.pi.model.id }, thinking: config.pi.thinking,
      runtime: options.pi?.runtime ?? (async () => (await createModelRuntime(config.pi, options.env)).runtime),
      configureSession: options.pi?.configureSession, now, log, loop: config.loop,
      ...(config.a2a ? { a2a: config.a2a, a2aClient } : {}),
      updates, ...(archive ? { slack: archive } : {}),
    });

    // Each workspace connects in the background: Slack being out of reach, or a token it refuses, must not hold the
    // server's start. The socket reconnects on its own, and every connection fills in what was missed.
    if (archive && slackConfig && !thinkingLoop.unavailable) {
      const connector = options.slack?.connector ?? connectSlack;
      for (const { name, botToken, appToken } of slackTokens) {
        const { api, socket } = connector({ botToken, appToken });
        const workspace = new SlackWorkspace({
          name, api, socket, archive, reaction: slackConfig.reaction, backfillDays: slackConfig.backfillDays,
          maxImageBytes: slackConfig.maxImageBytes, now, log,
          raise: record => thinkingLoop.raise('slack-mention', record),
        });
        slackWorkspaces.push(workspace);
        void workspace.start().then(
          () => { log(`slack (${name}): connecting`); },
          () => { log(`slack (${name}): could not start; check the tokens and the App's settings`); },
        );
      }
    }

    // Who she can ask, for the workspace to show her as /manual/agents (ADR 0036). The cards are fetched in the
    // background: an agent that is down must not hold the server's start.
    void writeAgentList({ directory: join(dataDirectory, AGENT_LIST_DIRECTORY), config: config.a2a, client: a2aClient,
      now: now(), timeZone: config.loop.timeZone }).then(
      ({ listed, unreachable }) => { log(`a2a: wrote the list of agents (${listed.length} listed, ${unreachable.length} out of reach)`); },
      () => { log('a2a: the list of agents could not be written'); },
    );

    // The nightly switch (ADR 0009), self-checks natsumi booked, pings in quiet moments and expressions
    // returning to neutral (ADR 0014). A night missed while stopped is caught up on the first tick.
    if (!thinkingLoop.unavailable) {
      scheduler = new Scheduler({
        loop: thinkingLoop, now, log, timeZone: config.loop.timeZone, awakeHours: config.loop.awakeHours,
        nightlyRotationAt: config.loop.nightlyRotationAt, pingIntervalMinutes: config.loop.pingIntervalMinutes,
        expressionResetMinutes: config.loop.expressionResetMinutes,
      });
      scheduler.start();
      // The tasks outside agents are working on, fetched now and then on the interval (ADR 0035). The first round
      // picks up what a previous process was waiting for.
      if (config.a2a) {
        const poll = () => { void thinkingLoop.pollAgents().catch(() => { log('a2a: a round of fetching failed'); }); };
        poll();
        timers.push(setInterval(poll, options.a2a?.pollIntervalMs ?? config.a2a.pollIntervalSeconds * 1000));
      }
    }

    const sessions = new SessionStore(db, now);
    const allowedUserId = config.github.allowedUserId;
    const registrations = new PushRegistrations(db, now);
    const connections = hub = new ConnectionHub({
      publicOrigin: config.publicOrigin, now, db, loop: thinkingLoop, streamBufferSize: options.streamBufferSize,
      // Connecting is a use of the session and renews it (ADR 0030).
      authenticate: request => {
        const token = bearerToken(request);
        const session = token ? sessions.verify(token, allowedUserId) : undefined;
        const expiresAt = session && sessions.renew(session.sessionId);
        return expiresAt ? { ...session!, expiresAt } : undefined;
      },
      renew: sessionId => sessions.renew(sessionId),
      push: {
        register: (deviceId, payload) => {
          const registration = parseRegistration(payload);
          if (!registration) return { kind: 'rejected', code: 'invalid-request' };
          registrations.save(deviceId, registration);
          return { kind: 'accepted', environment: registration.environment };
        },
      },
    });

    // Pushes to the iPhones that are away (ADR 0029). Registrations are kept either way, so adding apns later needs
    // no new registration from the devices.
    if (config.apns && apnsKey) {
      apns = new ApnsClient({ teamId: config.apns.teamId, keyId: config.apns.keyId, topic: config.apns.topic, key: apnsKey, now,
        origins: options.apns?.origins });
      notifier = new PushNotifier({
        db, loop: thinkingLoop, registrations, sender: apns, allowedUserId, isConnected: deviceId => connections.isConnected(deviceId),
        log, retryDelaysMs: options.apns?.retryDelaysMs,
      });
    } else {
      log('push: apns is not configured; registrations are kept and nothing is sent');
    }
    const login = new GitHubLogin({ config: config.github, clientSecret, endpoints: options.github ?? GITHUB_ENDPOINTS, sessions, now, log });
    const open = (files: { cert: Buffer; key: Buffer } | undefined) =>
      openListener({ listen: config.listen, tlsFiles: files, login, sessions, hub: connections, allowedUserId, log });

    const started = isoAt(Date.now());
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
      await writeStatus(dataDirectory, { ...status, updatedAt: isoAt(Date.now()) }).catch(() => {});
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
      void writeStatus(dataDirectory, { ...status, updatedAt: isoAt(Date.now()) }).catch(() => {});
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
            await writeStatus(dataDirectory, { ...status, state: 'stopped', updatedAt: isoAt(Date.now()) });
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
