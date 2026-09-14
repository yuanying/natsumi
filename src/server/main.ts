import { homedir } from 'node:os';
import { parseCli, UsageError } from './cli.ts';
import { resolveDataDirectory } from './data-directory.ts';
import { startServer } from './server.ts';
import { checkHealth, readStatus } from './status.ts';

process.umask(0o077);

try {
  const cli = parseCli(process.argv.slice(2));
  if (cli.command === 'health') {
    const result = checkHealth(await readStatus(await resolveDataDirectory(cli.dataDir, process.cwd())));
    process.stdout.write(`${result.reason}\n`);
    process.exitCode = result.healthy ? 0 : 1;
  } else {
    const server = await startServer({ config: cli.config, dataDir: cli.dataDir, cwd: process.cwd(), home: homedir() });
    // Pi reads its state area from here; the personal default under the home directory is never used.
    process.env.PI_CODING_AGENT_DIR = server.config.pi.agentDirectory;
    process.stdout.write(`natsumi: serving data directory (schema ${server.schemaVersion}); no network listener\n`);
    let signalled = false;
    const onSignal = () => {
      if (signalled) process.exit(1);
      signalled = true;
      server.stop().then(() => process.exit(0), error => { report(error); process.exit(1); });
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }
} catch (error) {
  report(error);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

function report(error: unknown) {
  process.stderr.write(`natsumi: ${error instanceof Error ? error.message : String(error)}\n`);
}
