import { chmod, mkdir } from 'node:fs/promises';

/**
 * Who may read and write what the server makes (ADR 0033).
 *
 * The workspace container, and the owner logging in over ssh, may run as a UID other than the server's. They share
 * a group with it instead, and write memory and the two working places through that group. So the server's umask
 * leaves the group everything and others nothing, and the shared places are directories with setgid, which keeps
 * what is made inside them in the shared group whoever makes it.
 *
 * What only the server uses — SQLite, the Pi state area, secrets, certificates — lives in directories kept to their
 * owner (0700). The umask opens nothing there, because nobody else can reach inside.
 */

/** The server's umask: the group may read and write, others may not. The workspace runner uses the same one. */
export const SERVER_UMASK = 0o007;

/** A place the server shares with the workspace: the group writes it, and setgid keeps new entries in that group. */
export const SHARED_DIRECTORY_MODE = 0o2770;

/** A file the server writes into a shared place. The umask above leaves it as it is. */
export const SHARED_FILE_MODE = 0o660;

/**
 * Makes a shared place, with its parents when `recursive`, and gives it the shared mode. An existing directory is
 * left as it is: its owner and mode are the operator's, set when the data was moved in (ADR 0033).
 * Returns false when the directory was already there.
 */
export async function makeSharedDirectory(path: string, options: { recursive?: boolean } = {}): Promise<boolean> {
  if (options.recursive) {
    // mkdir reports the first directory it made; nothing made means the whole path was there.
    if (await mkdir(path, { recursive: true, mode: 0o770 }) === undefined) return false;
  } else {
    try { await mkdir(path, { mode: 0o770 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }
  // mkdir takes neither setgid nor a mode wider than the umask; chmod takes both.
  await chmod(path, SHARED_DIRECTORY_MODE);
  return true;
}
