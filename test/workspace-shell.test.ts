import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_COMMAND_CHARS, SHELL_OUTPUT_CHARS, WorkspaceShell } from '../src/server/workspace-shell.ts';

const finished = {
  exitCode: 0, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
  stillRunning: false, responseLimitMs: 60000, running: 0,
};

/** A stand-in for the runner in the workspace container: answers each JSON line as `answer` says. */
async function fakeRunner(answer: (request: { command: string; timeZone?: string }) => object | string | 'silent') {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-shell-'));
  const path = join(root, 'runner.sock');
  const requests: { command: string; timeZone?: string }[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { command: string; timeZone?: string };
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
    const outcome = await new WorkspaceShell({ socketPath: runner.path, timeZone: 'Asia/Tokyo' }).run('rg 鍵');
    assert.deepEqual(runner.requests, [{ command: 'rg 鍵', timeZone: 'Asia/Tokyo' }]);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /終了コード 1/);
    assert.match(outcome.text, /標準出力は空/);
    assert.match(outcome.text, /rg: 鍵\.md: No such file/);
  } finally { await runner.close(); }
});

test('output is shown as it is when short', async () => {
  const runner = await fakeRunner(() => ({ ...finished, stdout: '合言葉.md:- 2026-09-15: 合言葉は SYNTHETIC-HERON-208\n' }));
  try {
    const outcome = await new WorkspaceShell({ socketPath: runner.path }).run('rg 合言葉 /memory');
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
    const shell = new WorkspaceShell({ socketPath: runner.path });
    const cut = await shell.run('cat big');
    assert.equal(cut.ok, true);
    assert.ok([...cut.text].length < SHELL_OUTPUT_CHARS * 1.5, `text is ${[...cut.text].length} characters`);
    assert.match(cut.text, /長いので.*先頭/);
    // The runner's own limit is reported too, even when the text that reached here is short.
    const runnerCut = await shell.run('cat other');
    assert.match(runnerCut.text, /長いので.*先頭/);
  } finally { await runner.close(); }
});

// The new guarantee of ADR 0019: the response limit answers, it does not stop the command.
test('a command that is still running comes back as an answer, not an error, and says it was not stopped', async () => {
  const runner = await fakeRunner(() => ({ ...finished, exitCode: null, stillRunning: true, running: 1, stdout: '途中まで\n' }));
  try {
    const outcome = await new WorkspaceShell({ socketPath: runner.path }).run('python3 /work/count.py');
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /まだ動いています/);
    assert.match(outcome.text, /60 秒/);
    assert.match(outcome.text, /途中まで/);
    // Nothing was killed, and what it prints from here on is thrown away.
    assert.doesNotMatch(outcome.text, /打ち切/);
    assert.match(outcome.text, /\/work/);
  } finally { await runner.close(); }
});

test('commands left running are counted in the result, and nothing is said when none are', async () => {
  const runner = await fakeRunner(request => ({ ...finished, running: request.command === 'ls' ? 0 : 3 }));
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path });
    assert.doesNotMatch((await shell.run('ls')).text, /まだ動いているコマンド/);
    const left = await shell.run('ps');
    assert.match(left.text, /まだ動いているコマンド.*3/);
    assert.match(left.text, /kill/);
  } finally { await runner.close(); }
});

test('a command that could not fork is told to look at what is left running', async () => {
  const runner = await fakeRunner(() => ({ ...finished, exitCode: 254, running: 40,
    stderr: 'bash: fork: retry: Resource temporarily unavailable\n' }));
  try {
    const outcome = await new WorkspaceShell({ socketPath: runner.path }).run('for i in $(seq 300); do sleep 60 & done');
    assert.match(outcome.text, /プロセス.*上限/);
    assert.match(outcome.text, /ps/);
    assert.match(outcome.text, /kill/);
  } finally { await runner.close(); }
});

test('a command stopped by a signal is an error that names the limits it may have hit', async () => {
  const runner = await fakeRunner(() => ({ ...finished, exitCode: null, signal: 'killed' }));
  try {
    const outcome = await new WorkspaceShell({ socketPath: runner.path }).run('python3 -c "x = bytearray(10**10)"');
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /シグナル/);
  } finally { await runner.close(); }
});

test('without a runner at the socket nothing runs, and the reason says memory is out of reach', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-shell-'));
  try {
    const started = Date.now();
    const outcome = await new WorkspaceShell({ socketPath: join(root, 'missing.sock') }).run('ls');
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /接続できません/);
    assert.match(outcome.text, /記憶/);
    assert.ok(Date.now() - started < 2000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a runner that does not answer in time is given up on', async () => {
  const runner = await fakeRunner(() => 'silent');
  try {
    const started = Date.now();
    const outcome = await new WorkspaceShell({ socketPath: runner.path, timeoutMs: 200 }).run('ls');
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /応答がありません/);
    assert.ok(Date.now() - started < 2000);
  } finally { await runner.close(); }
});

test('a malformed answer or a refusal from the runner is an error, not output', async () => {
  const runner = await fakeRunner(request => request.command === 'garbage' ? 'not json\n' : { error: 'request too large' });
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path });
    const garbage = await shell.run('garbage');
    assert.equal(garbage.ok, false);
    assert.match(garbage.text, /応答を読めません/);
    const refused = await shell.run('refused');
    assert.equal(refused.ok, false);
    assert.match(refused.text, /受け付けません/);
  } finally { await runner.close(); }
});

// ADR 0018's 8000 characters, which the runner can only take since its request limit went to 64 KiB (ADR 0019).
test('a command of 8000 characters is sent, and a longer one is refused before it leaves the server', async () => {
  const runner = await fakeRunner(() => finished);
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path });
    assert.equal(MAX_COMMAND_CHARS, 8000);
    const longest = `echo ${'あ'.repeat(MAX_COMMAND_CHARS - 5)}`;
    assert.equal([...longest].length, MAX_COMMAND_CHARS);
    assert.equal((await shell.run(longest)).ok, true);
    assert.deepEqual(runner.requests.map(request => request.command), [longest]);

    const over = await shell.run(`${longest}あ`);
    assert.equal(over.ok, false);
    assert.match(over.text, /8000/);
    assert.match(over.text, /\/work/);
    assert.equal(runner.requests.length, 1, 'an oversized command never reaches the runner');
  } finally { await runner.close(); }
});

test('an empty or NUL-carrying command is refused without asking the runner', async () => {
  const runner = await fakeRunner(() => finished);
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path });
    for (const command of ['', '   ', 'ls\u0000']) {
      const outcome = await shell.run(command);
      assert.equal(outcome.ok, false, JSON.stringify(command.slice(0, 10)));
    }
    assert.deepEqual(runner.requests, []);
  } finally { await runner.close(); }
});

// The `/work` boundary has no hint of its own, so the server says when memory did change (ADR 0019).
test('a line about what changed in memory is added only when something did', async () => {
  const runner = await fakeRunner(() => finished);
  let changes = '';
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path, memoryChanges: async () => changes });
    assert.doesNotMatch((await shell.run('ls /memory')).text, /記憶の変更/);
    changes = '予定.md（変更）, 新しい話.md（追加）';
    const after = await shell.run('echo x >> /memory/予定.md');
    assert.match(after.text, /記憶の変更: 予定\.md（変更）, 新しい話\.md（追加）/);
    // Nothing ran, so nothing is asked about memory either.
    const refused = await shell.run('');
    assert.doesNotMatch(refused.text, /記憶の変更/);
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
    const shell = new WorkspaceShell({ socketPath: path });
    const outcomes = await Promise.all([shell.run('ls'), shell.run('ls'), shell.run('ls')]);
    assert.deepEqual(outcomes.map(outcome => outcome.ok), [true, true, true]);
    assert.equal(overlapped, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
