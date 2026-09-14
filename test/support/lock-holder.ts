import { acquireProcessLock } from '../../src/server/lock.ts';

// argv: data directory. Holds the lock until killed and reports once it is held.
acquireProcessLock(process.argv[2]!);
process.send?.('held');
setInterval(() => {}, 1000);
