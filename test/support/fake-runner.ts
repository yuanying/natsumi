import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for the runner of the workspace container (ADR 0019), speaking the same one-JSON-line protocol over a
 * Unix socket. It runs each command with `bash -c` on the host, in the directory given, so a test can exercise the
 * whole path from the model's tool call to a file in the memory repository without Docker. Nothing else about the
 * container is imitated: the confinement is the container's, and it is measured by scripts/check-workspace-sandbox.sh.
 */
export interface FakeRunner {
  path: string;
  commands: string[];
  timeZones: (string | undefined)[];
  close(): Promise<void>;
}

export async function startFakeRunner(options: { dir: string; responseLimitMs?: number }): Promise<FakeRunner> {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-runner-'));
  const path = join(root, 'runner.sock');
  const commands: string[] = [];
  const timeZones: (string | undefined)[] = [];
  const sockets = new Set<Socket>();
  const responseLimitMs = options.responseLimitMs ?? 10_000;
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { command: string; timeZone?: string };
      commands.push(request.command);
      timeZones.push(request.timeZone);
      execFile('bash', ['-c', request.command], {
        cwd: options.dir, timeout: responseLimitMs, encoding: 'utf8', maxBuffer: 1 << 20,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: options.dir, LANG: 'C.UTF-8', TZ: request.timeZone ?? 'UTC' },
      }, (error, stdout, stderr) => {
        const killed = Boolean(error && (error as { killed?: boolean }).killed);
        socket.end(`${JSON.stringify({
          exitCode: killed ? null : Number((error as { code?: number } | null)?.code ?? 0),
          stdout: String(stdout), stderr: String(stderr), stdoutTruncated: false, stderrTruncated: false,
          stillRunning: killed, responseLimitMs, running: killed ? 1 : 0,
        })}\n`);
      });
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return {
    path, commands, timeZones,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
