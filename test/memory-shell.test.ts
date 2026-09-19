import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_COMMAND_CHARS, MEMORY_SHELL_COMMANDS, MemoryShell, SHELL_OUTPUT_CHARS } from '../src/server/memory-shell.ts';

const finished = { exitCode: 0, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, timeoutMs: 10000 };

/** A stand-in for the runner in the tools container: answers each JSON line as `answer` says. */
async function fakeRunner(answer: (request: { command: string }) => object | string | 'silent') {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-shell-'));
  const path = join(root, 'runner.sock');
  const requests: { command: string }[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { command: string };
      requests.push(request);
      const reply = answer(request);
      if (reply === 'silent') return;
      socket.end(typeof reply === 'string' ? reply : `${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return {
    path, requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('a finished command comes back as a sentence with its exit code, output and stderr', async () => {
  const runner = await fakeRunner(() => ({ ...finished, exitCode: 1, stderr: 'rg: 鍵.md: No such file\n' }));
  try {
    const outcome = await new MemoryShell({ socketPath: runner.path }).run('rg 鍵');
    assert.deepEqual(runner.requests, [{ command: 'rg 鍵' }]);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /終了コード 1/);
    assert.match(outcome.text, /標準出力は空/);
    assert.match(outcome.text, /rg: 鍵\.md: No such file/);
  } finally { await runner.close(); }
});

test('output is shown as it is when short', async () => {
  const runner = await fakeRunner(() => ({ ...finished, stdout: '合言葉.md:- 2026-09-15: 合言葉は SYNTHETIC-HERON-208\n' }));
  try {
    const outcome = await new MemoryShell({ socketPath: runner.path }).run('rg 合言葉');
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /終了コード 0/);
    assert.match(outcome.text, /SYNTHETIC-HERON-208/);
    assert.doesNotMatch(outcome.text, /長い/);
  } finally { await runner.close(); }
});

test('long output is cut on the server too, and the model is told how to narrow it', async () => {
  const long = 'あ'.repeat(SHELL_OUTPUT_CHARS + 500);
  const runner = await fakeRunner(request => request.command === 'cat big'
    ? { ...finished, stdout: long, stderr: 'い'.repeat(SHELL_OUTPUT_CHARS) }
    : { ...finished, stdout: 'う'.repeat(100), stdoutTruncated: true });
  try {
    const shell = new MemoryShell({ socketPath: runner.path });
    const cut = await shell.run('cat big');
    assert.equal(cut.ok, true);
    assert.ok([...cut.text].length < SHELL_OUTPUT_CHARS * 1.5, `text is ${[...cut.text].length} characters`);
    assert.match(cut.text, /長いので.*先頭/);
    assert.match(cut.text, /head|-m/);
    // The runner's own limit is reported too, even when the text that reached here is short.
    const runnerCut = await shell.run('cat other');
    assert.match(runnerCut.text, /長いので.*先頭/);
  } finally { await runner.close(); }
});

test('a command stopped at the time limit is an error that says so and keeps what it printed', async () => {
  const runner = await fakeRunner(() => ({ ...finished, exitCode: null, signal: 'killed', timedOut: true, stdout: '途中まで\n' }));
  try {
    const outcome = await new MemoryShell({ socketPath: runner.path }).run('find / -name x');
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /10 秒/);
    assert.match(outcome.text, /打ち切/);
    assert.match(outcome.text, /途中まで/);
  } finally { await runner.close(); }
});

test('without a runner at the socket nothing runs, and the reason points back to the memory tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-shell-'));
  try {
    const started = Date.now();
    const outcome = await new MemoryShell({ socketPath: join(root, 'missing.sock') }).run('ls');
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /接続できません/);
    assert.match(outcome.text, /記憶を読むことも書くこともできません/);
    assert.ok(Date.now() - started < 2000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a runner that does not answer in time is given up on', async () => {
  const runner = await fakeRunner(() => 'silent');
  try {
    const started = Date.now();
    const outcome = await new MemoryShell({ socketPath: runner.path, timeoutMs: 200 }).run('ls');
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /応答がありません/);
    assert.ok(Date.now() - started < 2000);
  } finally { await runner.close(); }
});

test('a malformed answer or a refusal from the runner is an error, not output', async () => {
  const runner = await fakeRunner(request => request.command === 'garbage' ? 'not json\n' : { error: 'request too large' });
  try {
    const shell = new MemoryShell({ socketPath: runner.path });
    const garbage = await shell.run('garbage');
    assert.equal(garbage.ok, false);
    assert.match(garbage.text, /応答を読めません/);
    const refused = await shell.run('refused');
    assert.equal(refused.ok, false);
    assert.match(refused.text, /受け付けません/);
  } finally { await runner.close(); }
});

test('an empty, oversized or NUL-carrying command is refused without asking the runner', async () => {
  const runner = await fakeRunner(() => finished);
  try {
    const shell = new MemoryShell({ socketPath: runner.path });
    for (const command of ['', '   ', 'a'.repeat(MAX_COMMAND_CHARS + 1), 'ls\u0000']) {
      const outcome = await shell.run(command);
      assert.equal(outcome.ok, false, JSON.stringify(command.slice(0, 10)));
    }
    assert.deepEqual(runner.requests, []);
  } finally { await runner.close(); }
});

test('commands run one at a time', async () => {
  let running = 0;
  let overlapped = false;
  const root = await mkdtemp(join(tmpdir(), 'natsumi-shell-'));
  const path = join(root, 'runner.sock');
  // Answers after a delay and records whether a second command arrived meanwhile.
  const server = createServer(socket => {
    socket.once('data', () => {
      running += 1;
      if (running > 1) overlapped = true;
      setTimeout(() => { running -= 1; socket.end(`${JSON.stringify(finished)}\n`); }, 50);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const shell = new MemoryShell({ socketPath: path });
    const outcomes = await Promise.all([shell.run('ls'), shell.run('ls'), shell.run('ls')]);
    assert.deepEqual(outcomes.map(outcome => outcome.ok), [true, true, true]);
    assert.equal(overlapped, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('the commands the tool describes are exactly the ones the tools image installs', async () => {
  const listed = (await readFile(new URL('../docker/tools-commands.txt', import.meta.url), 'utf8'))
    .split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
  assert.deepEqual([...listed].sort(), [...MEMORY_SHELL_COMMANDS].sort());
  // Memory is written with these now (ADR 0018); the history stays out of reach in the container's read-only .git.
  for (const writing of ['mkdir', 'mv', 'cp', 'rm', 'sed', 'awk']) assert.equal(listed.includes(writing), true, writing);
  for (const forbidden of ['curl', 'wget', 'nc', 'python3', 'node', 'git', 'apt']) {
    assert.equal(listed.includes(forbidden), false, forbidden);
  }
});
