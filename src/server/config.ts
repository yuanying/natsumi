import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

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
  /** Voice is unsupported until its method and billing terms are verified (ADR 0004). */
  voiceEnabled: false;
}

export interface ServerConfig {
  pi: PiConfig;
}

type Section<T> = (value: unknown, path: string) => T;

/**
 * Top-level sections. A later change adds a setting by adding its parser here and its field to ServerConfig.
 * Anything not listed is rejected so a typo cannot silently disable a safety setting.
 */
const SECTIONS = {
  pi: parsePi,
} satisfies { [K in keyof ServerConfig]: Section<ServerConfig[K]> };

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
  return { pi: SECTIONS.pi(required(root, 'pi', ''), 'pi') };
}

function parsePi(value: unknown, path: string): PiConfig {
  const pi = object(value, path);
  onlyKeys(pi, path, ['agentDirectory', 'sessionDirectory', 'authPath', 'model', 'voiceEnabled']);
  const modelPath = `${path}.model`;
  const model = object(required(pi, 'model', path), modelPath);
  onlyKeys(model, modelPath, ['provider', 'id']);
  const voice = required(pi, 'voiceEnabled', path);
  if (voice !== false) throw new ConfigError(`${path}.voiceEnabled`, 'voice is not supported; set false');
  return {
    agentDirectory: absolutePath(required(pi, 'agentDirectory', path), `${path}.agentDirectory`),
    sessionDirectory: absolutePath(required(pi, 'sessionDirectory', path), `${path}.sessionDirectory`),
    authPath: absolutePath(required(pi, 'authPath', path), `${path}.authPath`),
    model: {
      provider: nonEmptyString(required(model, 'provider', modelPath), `${modelPath}.provider`),
      id: nonEmptyString(required(model, 'id', modelPath), `${modelPath}.id`),
    },
    voiceEnabled: false,
  };
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
