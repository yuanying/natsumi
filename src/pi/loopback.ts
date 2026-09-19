import { isIP } from 'node:net';

/**
 * The one rule for "this address never leaves the host", shared by the config parser and the Pi runtime so that a
 * plaintext endpoint the config accepts is always one the runtime will open.
 *
 * 127.0.0.0/8, ::1 and localhost. Accepts a URL hostname, where IPv6 is bracketed.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  return bare === 'localhost' || bare === '::1' || (isIP(bare) === 4 && bare.startsWith('127.'));
}
