import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { COMPATIBLE_PROVIDER } from '../pi/auth.ts';
import { isLoopbackHost } from '../pi/loopback.ts';
import { DEFAULT_FILE_MAX_CHARS } from './memory-repository.ts';
import { DEFAULT_SHELL_WAIT_SECONDS } from './workspace-shell.ts';
import { DEFAULT_SIZE_WARN_BYTES } from './workspace-size.ts';
import { isValidTimeZone, TIME_OF_DAY } from './nightly.ts';
import { DEFAULT_AWAKE_HOURS, DEFAULT_EXPRESSION_RESET_MINUTES, DEFAULT_PING_INTERVAL_MINUTES, DEFAULT_SELF_CHECK_LIMITS,
  type AwakeHours, type SelfCheckLimits } from './scheduler.ts';

/** A startup-stopping config problem. `path` names the setting (for example `pi.authPath`); values are never echoed. */
export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

export interface PiConfig {
  agentDirectory: string;
  sessionDirectory: string;
  authPath: string;
  model: { provider: string; id: string };
  /** Present only for the `natsumi-compatible` provider. Without it the OAuth login at `authPath` is the only route. */
  compatible?: CompatibleConfig;
  /** Whether the model thinks before it acts. On by default (ADR 0008). */
  thinking: 'on' | 'off';
  /** Voice is unsupported until its method and billing terms are verified (ADR 0004). */
  voiceEnabled: false;
}

/** An OpenAI-compatible Chat Completions endpoint the owner runs (ADR 0004). */
export interface CompatibleConfig {
  baseUrl: string;
  apiKey: SecretReference;
}

export { COMPATIBLE_PROVIDER };

export interface TlsConfig { certFile: string; keyFile: string }

export const LETS_ENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

/** Certificates obtained and renewed by the server itself over ACME HTTP-01 for the publicOrigin host (ADR 0007). */
export interface AcmeConfig {
  directoryUrl: string;
  contactEmail?: string;
  /** The plaintext port answering HTTP-01 challenges. CAs validate on port 80. */
  httpPort: number;
}

export interface ListenConfig {
  host: string;
  port: number;
  /** `false` (plaintext) is accepted only on a loopback host, for a reverse proxy on the same host (ADR 0006). */
  tls: TlsConfig | { acme: AcmeConfig } | false;
}

/** A secret named by environment variable or read from a secret mount; never the value itself. */
export type SecretReference = { env: string } | { file: string };

export interface GitHubConfig {
  clientId: string;
  clientSecret: SecretReference;
  callbackUrl: string;
  /** The one GitHub account allowed in, by its numeric user ID. Login names can change hands (ADR 0002). */
  allowedUserId: number;
}

/** How the thinking loop keeps its Pi session in shape (ADR 0009). Token counts are Pi's context estimates. */
export interface LoopConfig {
  /** The owner's IANA time zone: memory dates and the nightly switch use it. */
  timeZone: string;
  /** Local `HH:MM` of the nightly session switch, or false to switch only by hand. */
  nightlyRotationAt: string | false;
  /** Past this many context tokens the session is compacted between turns. */
  compactionThreshold: number;
  /** Recent context tokens a compaction keeps as they are. */
  compactionKeepRecent: number;
  /** The Unix socket of the workspace container's runner (ADR 0019). Without it the model gets no shell. */
  workspaceSocket?: string;
  /** Seconds the server waits for the runner's answer. Longer than the runner's own response limit (ADR 0019). */
  shellWaitSeconds: number;
  /** Past this many bytes across the three persistent places, the next turn is told, with the breakdown (ADR 0019). */
  workspaceSizeWarnBytes: number;
  /** The git repository holding memory (ADR 0018). `memory/` in the data directory when omitted. */
  memoryRepository?: string;
  /** The longest one memory file may be, in characters. A file over it goes back to the previous commit. */
  memoryFileMaxChars: number;
  /** Local hours natsumi is up. Pings and self-checks come only inside them (ADR 0014). */
  awakeHours: AwakeHours;
  /** Quiet minutes before a ping, or false for no pings. */
  pingIntervalMinutes: number | false;
  /** Limits on the checks natsumi books for herself. */
  selfCheck: SelfCheckLimits;
  /** Minutes an expression other than thinking stays before returning to neutral. */
  expressionResetMinutes: number;
}

export const LOOP_DEFAULTS: LoopConfig = {
  timeZone: 'UTC', nightlyRotationAt: '04:00', compactionThreshold: 60000, compactionKeepRecent: 20000,
  memoryFileMaxChars: DEFAULT_FILE_MAX_CHARS, shellWaitSeconds: DEFAULT_SHELL_WAIT_SECONDS,
  workspaceSizeWarnBytes: DEFAULT_SIZE_WARN_BYTES,
  awakeHours: DEFAULT_AWAKE_HOURS, pingIntervalMinutes: DEFAULT_PING_INTERVAL_MINUTES, selfCheck: DEFAULT_SELF_CHECK_LIMITS,
  expressionResetMinutes: DEFAULT_EXPRESSION_RESET_MINUTES,
};

/** The shortest ping interval, so a typo cannot make natsumi think all day. */
const MIN_PING_INTERVAL_MINUTES = 5;
/** Below this a memory file could not hold a topic, and every night's work would go back. */
const MIN_MEMORY_FILE_MAX_CHARS = 1000;
/** Under the runner's own response limit (60 seconds, ADR 0019) the answer would never reach the server. */
const MIN_SHELL_WAIT_SECONDS = 10;
/** A warning under a kibibyte would fire on an empty workspace. */
const MIN_SIZE_WARN_BYTES = 1024;

export interface ServerConfig {
  pi: PiConfig;
  /** The origin clients use, such as `https://natsumi.example.net`. WebSocket Origin headers must match it. */
  publicOrigin: string;
  listen: ListenConfig;
  github: GitHubConfig;
  loop: LoopConfig;
}

export const GITHUB_CALLBACK_PATH = '/auth/github/callback';

type Section<T> = (value: unknown, path: string) => T;

/**
 * Top-level sections. A later change adds a setting by adding its parser here and its field to ServerConfig.
 * Anything not listed is rejected so a typo cannot silently disable a safety setting.
 */
const SECTIONS = {
  pi: parsePi,
  publicOrigin: parsePublicOrigin,
  listen: parseListen,
  github: parseGitHub,
  loop: parseLoop,
} satisfies { [K in keyof ServerConfig]: Section<ServerConfig[K]> };

/** Settings ADR 0019 renamed. The old name stops startup rather than being ignored: it would switch the shell off. */
const RENAMED_LOOP_KEYS: Record<string, string> = {
  memoryShellSocket: 'workspaceSocket',
};

const MOVED: Record<string, string> = {
  dataDirectory: 'the data directory is chosen with --data-dir or the launch directory, not in the config',
};

export async function loadConfig(file: string): Promise<ServerConfig> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { throw new ConfigError('config', 'cannot read the config file'); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ConfigError('config', 'the config file is not valid JSON'); }
  return parseConfig(raw);
}

export function parseConfig(raw: unknown): ServerConfig {
  const root = object(raw, 'config');
  refuseSecrets(root, '');
  for (const key of Object.keys(root)) {
    if (MOVED[key]) throw new ConfigError(key, MOVED[key]);
    if (!(key in SECTIONS)) throw new ConfigError(key, 'unknown setting');
  }
  const config: ServerConfig = {
    pi: SECTIONS.pi(required(root, 'pi', ''), 'pi'),
    publicOrigin: SECTIONS.publicOrigin(required(root, 'publicOrigin', ''), 'publicOrigin'),
    listen: SECTIONS.listen(required(root, 'listen', ''), 'listen'),
    github: SECTIONS.github(required(root, 'github', ''), 'github'),
    loop: SECTIONS.loop(root.loop ?? {}, 'loop'),
  };
  if (new URL(config.github.callbackUrl).origin !== config.publicOrigin) {
    throw new ConfigError('github.callbackUrl', 'must be on publicOrigin');
  }
  if (config.listen.tls && 'acme' in config.listen.tls) {
    const host = new URL(config.publicOrigin).hostname.replace(/^\[(.*)\]$/, '$1');
    if (isIP(host) !== 0 || host === 'localhost' || !host.includes('.')) {
      throw new ConfigError('publicOrigin', 'ACME needs a DNS host name, not an IP address or a single label');
    }
  }
  return config;
}

function parsePi(value: unknown, path: string): PiConfig {
  const pi = object(value, path);
  onlyKeys(pi, path, ['agentDirectory', 'sessionDirectory', 'authPath', 'model', 'compatible', 'thinking', 'voiceEnabled']);
  const modelPath = `${path}.model`;
  const model = object(required(pi, 'model', path), modelPath);
  onlyKeys(model, modelPath, ['provider', 'id']);
  const voice = required(pi, 'voiceEnabled', path);
  if (voice !== false) throw new ConfigError(`${path}.voiceEnabled`, 'voice is not supported; set false');
  const thinking = pi.thinking === undefined ? 'on' : pi.thinking;
  if (thinking !== 'on' && thinking !== 'off') throw new ConfigError(`${path}.thinking`, 'must be "on" or "off"');
  const provider = nonEmptyString(required(model, 'provider', modelPath), `${modelPath}.provider`);
  // The route is chosen explicitly and never falls back: the compatible provider and its endpoint come together.
  let compatible: CompatibleConfig | undefined;
  if (pi.compatible !== undefined) {
    if (provider !== COMPATIBLE_PROVIDER) {
      throw new ConfigError(`${modelPath}.provider`, `must be ${COMPATIBLE_PROVIDER} when ${path}.compatible is set`);
    }
    compatible = parseCompatible(pi.compatible, `${path}.compatible`);
  } else if (provider === COMPATIBLE_PROVIDER) {
    throw new ConfigError(`${path}.compatible`, `is required for the ${COMPATIBLE_PROVIDER} provider`);
  }
  return {
    agentDirectory: absolutePath(required(pi, 'agentDirectory', path), `${path}.agentDirectory`),
    sessionDirectory: absolutePath(required(pi, 'sessionDirectory', path), `${path}.sessionDirectory`),
    authPath: absolutePath(required(pi, 'authPath', path), `${path}.authPath`),
    model: { provider, id: nonEmptyString(required(model, 'id', modelPath), `${modelPath}.id`) },
    ...(compatible ? { compatible } : {}),
    thinking,
    voiceEnabled: false,
  };
}

function parseCompatible(value: unknown, path: string): CompatibleConfig {
  const compatible = object(value, path);
  onlyKeys(compatible, path, ['baseUrl', 'apiKeyEnv', 'apiKeyFile']);
  const baseUrlPath = `${path}.baseUrl`;
  const url = parseUrl(required(compatible, 'baseUrl', path), baseUrlPath);
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(baseUrlPath, 'must not carry credentials, a query or a fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new ConfigError(baseUrlPath, 'must use https (http is accepted only for a loopback host)');
  }
  return { baseUrl: url.href, apiKey: secretReference(compatible, path, 'apiKey') };
}

function parsePublicOrigin(value: unknown, path: string): string {
  const url = parseUrl(value, path);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(path, 'must be an origin without a path, query or credentials');
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url.origin;
  throw new ConfigError(path, 'must use https (http is accepted only for a loopback host)');
}

function parseListen(value: unknown, path: string): ListenConfig {
  const listen = object(value, path);
  onlyKeys(listen, path, ['host', 'port', 'tls']);
  const host = nonEmptyString(required(listen, 'host', path), `${path}.host`);
  if (host !== 'localhost' && isIP(host) === 0) throw new ConfigError(`${path}.host`, 'must be an IP address or localhost');
  const port = required(listen, 'port', path);
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`${path}.port`, 'must be an integer from 0 to 65535');
  }
  const tlsPath = `${path}.tls`;
  const tls = required(listen, 'tls', path);
  if (tls === false) {
    // Plaintext is never exposed beyond this host: the only exception is loopback behind a local TLS proxy.
    if (!isLoopbackHost(host)) throw new ConfigError(tlsPath, 'plaintext is accepted only on a loopback host; set certFile and keyFile');
    return { host, port, tls: false };
  }
  if (typeof tls !== 'object' || tls === null || Array.isArray(tls)) {
    throw new ConfigError(tlsPath, 'must be { certFile, keyFile }, { acme }, or false on a loopback host');
  }
  const files = tls as Record<string, unknown>;
  if ('acme' in files) {
    if (Object.keys(files).length !== 1) throw new ConfigError(tlsPath, 'set either certFile and keyFile, or acme');
    return { host, port, tls: { acme: parseAcme(files.acme, `${tlsPath}.acme`, port) } };
  }
  onlyKeys(files, tlsPath, ['certFile', 'keyFile']);
  return {
    host, port,
    tls: {
      certFile: absolutePath(required(files, 'certFile', tlsPath), `${tlsPath}.certFile`),
      keyFile: absolutePath(required(files, 'keyFile', tlsPath), `${tlsPath}.keyFile`),
    },
  };
}

const EMAIL = /^[^\s@:,;<>()[\]"\\]+@[^\s@:,;<>()[\]"\\]+\.[^\s@:,;<>()[\]"\\]+$/;

function parseAcme(value: unknown, path: string, listenPort: number): AcmeConfig {
  const acme = object(value, path);
  onlyKeys(acme, path, ['directoryUrl', 'contactEmail', 'httpPort']);
  let directoryUrl = LETS_ENCRYPT_PRODUCTION;
  if (acme.directoryUrl !== undefined) {
    const urlPath = `${path}.directoryUrl`;
    const url = parseUrl(acme.directoryUrl, urlPath);
    if (url.username || url.password || url.hash) throw new ConfigError(urlPath, 'must not contain credentials or a fragment');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      throw new ConfigError(urlPath, 'must use https (http is accepted only for a loopback host)');
    }
    directoryUrl = url.href;
  }
  const email = acme.contactEmail;
  if (email !== undefined && (typeof email !== 'string' || !EMAIL.test(email))) {
    throw new ConfigError(`${path}.contactEmail`, 'must be a single email address without mailto:');
  }
  const httpPort = acme.httpPort ?? 80;
  if (typeof httpPort !== 'number' || !Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535) {
    throw new ConfigError(`${path}.httpPort`, 'must be an integer from 0 to 65535');
  }
  if (httpPort !== 0 && httpPort === listenPort) throw new ConfigError(`${path}.httpPort`, 'must differ from listen.port');
  return { directoryUrl, ...(email === undefined ? {} : { contactEmail: email }), httpPort };
}

function parseGitHub(value: unknown, path: string): GitHubConfig {
  const github = object(value, path);
  onlyKeys(github, path, ['clientId', 'clientSecretEnv', 'clientSecretFile', 'callbackUrl', 'allowedUserId']);
  const clientSecret = secretReference(github, path, 'clientSecret');
  const callbackPath = `${path}.callbackUrl`;
  const callback = parseUrl(required(github, 'callbackUrl', path), callbackPath);
  if (callback.pathname !== GITHUB_CALLBACK_PATH || callback.search || callback.hash || callback.username || callback.password) {
    throw new ConfigError(callbackPath, `must be publicOrigin followed by ${GITHUB_CALLBACK_PATH}`);
  }
  const id = required(github, 'allowedUserId', path);
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new ConfigError(`${path}.allowedUserId`, 'must be a numeric GitHub user ID, not a login name');
  }
  return {
    clientId: nonEmptyString(required(github, 'clientId', path), `${path}.clientId`),
    clientSecret, callbackUrl: callback.href, allowedUserId: id,
  };
}

function parseLoop(value: unknown, path: string): LoopConfig {
  const loop = object(value, path);
  for (const [old, now] of Object.entries(RENAMED_LOOP_KEYS)) {
    if (old in loop) throw new ConfigError(`${path}.${old}`, `renamed to ${now} (ADR 0019)`);
  }
  onlyKeys(loop, path, ['timeZone', 'nightlyRotationAt', 'compactionThreshold', 'compactionKeepRecent', 'workspaceSocket',
    'shellWaitSeconds', 'workspaceSizeWarnBytes', 'memoryRepository', 'memoryFileMaxChars', 'awakeHours',
    'pingIntervalMinutes', 'selfCheck', 'expressionResetMinutes']);
  const timeZone = loop.timeZone ?? LOOP_DEFAULTS.timeZone;
  if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) throw new ConfigError(`${path}.timeZone`, 'must be an IANA time zone such as Asia/Tokyo');
  const at = loop.nightlyRotationAt ?? LOOP_DEFAULTS.nightlyRotationAt;
  if (at !== false && (typeof at !== 'string' || !TIME_OF_DAY.test(at))) {
    throw new ConfigError(`${path}.nightlyRotationAt`, 'must be a 24-hour HH:MM time, or false');
  }
  const threshold = loop.compactionThreshold ?? LOOP_DEFAULTS.compactionThreshold;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 10000) {
    throw new ConfigError(`${path}.compactionThreshold`, 'must be an integer of at least 10000');
  }
  const keep = loop.compactionKeepRecent ?? LOOP_DEFAULTS.compactionKeepRecent;
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 1000) {
    throw new ConfigError(`${path}.compactionKeepRecent`, 'must be an integer of at least 1000');
  }
  if (keep >= threshold) throw new ConfigError(`${path}.compactionKeepRecent`, 'must be smaller than compactionThreshold');
  const socket = loop.workspaceSocket === undefined ? undefined : absolutePath(loop.workspaceSocket, `${path}.workspaceSocket`);
  const wait = loop.shellWaitSeconds ?? LOOP_DEFAULTS.shellWaitSeconds;
  if (!positiveInteger(wait, MIN_SHELL_WAIT_SECONDS)) {
    throw new ConfigError(`${path}.shellWaitSeconds`, `must be an integer of at least ${MIN_SHELL_WAIT_SECONDS}`);
  }
  const warnBytes = loop.workspaceSizeWarnBytes ?? LOOP_DEFAULTS.workspaceSizeWarnBytes;
  if (!positiveInteger(warnBytes, MIN_SIZE_WARN_BYTES)) {
    throw new ConfigError(`${path}.workspaceSizeWarnBytes`, `must be an integer of at least ${MIN_SIZE_WARN_BYTES}`);
  }
  const repository = loop.memoryRepository === undefined ? undefined : absolutePath(loop.memoryRepository, `${path}.memoryRepository`);
  const fileMax = loop.memoryFileMaxChars ?? LOOP_DEFAULTS.memoryFileMaxChars;
  if (!positiveInteger(fileMax, MIN_MEMORY_FILE_MAX_CHARS)) {
    throw new ConfigError(`${path}.memoryFileMaxChars`, `must be an integer of at least ${MIN_MEMORY_FILE_MAX_CHARS}`);
  }
  const ping = loop.pingIntervalMinutes ?? LOOP_DEFAULTS.pingIntervalMinutes;
  if (ping !== false && !positiveInteger(ping, MIN_PING_INTERVAL_MINUTES)) {
    throw new ConfigError(`${path}.pingIntervalMinutes`, `must be an integer of at least ${MIN_PING_INTERVAL_MINUTES}, or false`);
  }
  const reset = loop.expressionResetMinutes ?? LOOP_DEFAULTS.expressionResetMinutes;
  if (!positiveInteger(reset, 1)) throw new ConfigError(`${path}.expressionResetMinutes`, 'must be a positive integer');
  return {
    timeZone, nightlyRotationAt: at, compactionThreshold: threshold, compactionKeepRecent: keep,
    ...(socket ? { workspaceSocket: socket } : {}), shellWaitSeconds: wait as number, workspaceSizeWarnBytes: warnBytes as number,
    ...(repository ? { memoryRepository: repository } : {}), memoryFileMaxChars: fileMax as number,
    awakeHours: parseAwakeHours(loop.awakeHours ?? LOOP_DEFAULTS.awakeHours, `${path}.awakeHours`),
    pingIntervalMinutes: ping as number | false,
    selfCheck: parseSelfCheck(loop.selfCheck ?? {}, `${path}.selfCheck`),
    expressionResetMinutes: reset as number,
  };
}

function parseAwakeHours(value: unknown, path: string): AwakeHours {
  const hours = object(value, path);
  onlyKeys(hours, path, ['start', 'end']);
  for (const key of ['start', 'end']) {
    const time = hours[key];
    if (typeof time !== 'string' || !TIME_OF_DAY.test(time)) throw new ConfigError(`${path}.${key}`, 'must be a 24-hour HH:MM time');
  }
  if (hours.start === hours.end) throw new ConfigError(`${path}.end`, 'must differ from start');
  return { start: hours.start as string, end: hours.end as string };
}

function parseSelfCheck(value: unknown, path: string): SelfCheckLimits {
  const limits = object(value, path);
  const keys = Object.keys(DEFAULT_SELF_CHECK_LIMITS) as (keyof SelfCheckLimits)[];
  onlyKeys(limits, path, keys);
  const parsed = { ...DEFAULT_SELF_CHECK_LIMITS };
  for (const key of keys) {
    const limit = limits[key] ?? DEFAULT_SELF_CHECK_LIMITS[key];
    if (!positiveInteger(limit, 1)) throw new ConfigError(`${path}.${key}`, 'must be a positive integer');
    parsed[key] = limit as number;
  }
  if (parsed.minDelayMinutes >= parsed.maxDelayDays * 1440) {
    throw new ConfigError(`${path}.minDelayMinutes`, 'must be shorter than maxDelayDays');
  }
  return parsed;
}

function positiveInteger(value: unknown, least: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= least;
}

// Helpers for section parsers.

export function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConfigError(path, 'must be an object');
  return value as Record<string, unknown>;
}

export function required(parent: Record<string, unknown>, key: string, path: string): unknown {
  if (parent[key] === undefined) throw new ConfigError(path ? `${path}.${key}` : key, 'is required');
  return parent[key];
}

export function onlyKeys(value: Record<string, unknown>, path: string, keys: string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ConfigError(`${path}.${key}`, 'unknown setting');
}

export function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(path, 'must be a non-empty string');
  return value;
}

export function absolutePath(value: unknown, path: string): string {
  const text = nonEmptyString(value, path);
  if (!isAbsolute(text)) throw new ConfigError(path, 'must be an absolute path');
  return text;
}

function parseUrl(value: unknown, path: string): URL {
  const text = nonEmptyString(value, path);
  try { return new URL(text); } catch { throw new ConfigError(path, 'must be a URL'); }
}

/** Exactly one of `<name>Env` and `<name>File`. */
function secretReference(parent: Record<string, unknown>, path: string, name: string): SecretReference {
  const env = parent[`${name}Env`];
  const file = parent[`${name}File`];
  if (env !== undefined && file !== undefined) {
    throw new ConfigError(`${path}.${name}File`, `set only one of ${name}Env and ${name}File`);
  }
  if (env !== undefined) return { env: envReference(env, `${path}.${name}Env`) };
  if (file !== undefined) return { file: absolutePath(file, `${path}.${name}File`) };
  throw new ConfigError(`${path}.${name}Env`, `is required (or ${name}File)`);
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** A secret referenced by environment variable name, for settings named `...Env`. */
export function envReference(value: unknown, path: string): string {
  const text = nonEmptyString(value, path);
  if (!ENV_NAME.test(text)) throw new ConfigError(path, 'must be an environment variable name');
  return text;
}

// Secrets are referenced by `...Env` (variable name) or `...File` (secret mount path), never written inline.
const SECRET_KEY = /secret|token|password|passphrase|api[-_]?key|private[-_]?key|credential/i;
const SECRET_VALUE = /^(sk-|gh[pousr]_|github_pat_|xox[abprs]-|AIza|ya29\.)|-----BEGIN /;

function refuseSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) { value.forEach((item, i) => refuseSecrets(item, `${path}[${i}]`)); return; }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key.endsWith('Env')) {
        if (typeof child !== 'string' || !ENV_NAME.test(child)) throw leaked(childPath, 'name an environment variable');
      } else if (key.endsWith('File')) {
        if (typeof child !== 'string' || !isAbsolute(child)) throw leaked(childPath, 'give an absolute secret file path');
      } else if (SECRET_KEY.test(key) && typeof child !== 'object') {
        throw leaked(childPath, `use ${key}Env or ${key}File`);
      } else {
        refuseSecrets(child, childPath);
      }
    }
    return;
  }
  if (typeof value === 'string' && SECRET_VALUE.test(value)) throw leaked(path, 'reference it by environment variable or secret file');
}

function leaked(path: string, hint: string): ConfigError {
  return new ConfigError(path, `secrets must not be written in the config; ${hint}`);
}
