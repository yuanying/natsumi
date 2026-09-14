import { readFile } from 'node:fs/promises';
import { ConfigError, type SecretReference, type TlsConfig } from './config.ts';

/** Resolves a `...Env` / `...File` reference. Errors name the setting only, never the variable, path or value. */
export async function readSecret(reference: SecretReference, path: string, env: Record<string, string | undefined>): Promise<string> {
  if ('env' in reference) {
    const value = env[reference.env];
    if (!value) throw new ConfigError(`${path}Env`, 'the referenced environment variable is not set');
    return value;
  }
  let value = '';
  try { value = (await readFile(reference.file, 'utf8')).trim(); } catch { /* reported below */ }
  if (!value) throw new ConfigError(`${path}File`, 'cannot read the referenced secret file');
  return value;
}

export async function readTlsFiles(tls: TlsConfig, path: string): Promise<{ cert: Buffer; key: Buffer }> {
  const read = async (file: string, name: string) => {
    try { return await readFile(file); } catch { throw new ConfigError(`${path}.${name}`, 'cannot read the referenced file'); }
  };
  return { cert: await read(tls.certFile, 'certFile'), key: await read(tls.keyFile, 'keyFile') };
}
