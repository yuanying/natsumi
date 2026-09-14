import { spawn, execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { RpcClient, RpcError, record } from './rpc.ts';
import { requirePlus, verifyHistory, realtimeOutcome, realtimeErrorCategory, realtimeErrorSignals } from './probe-checks.ts';

// No credentials, raw events, paths, model text, or provider errors are logged.
const report: Record<string, unknown> = { text: 'not-run', realtime: 'not-run', macAudio: 'not-tested' };
let stage = 'arguments';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'auth-ref': { type: 'string' }, realtime: { type: 'boolean' } } });
  const authRef = values['auth-ref'];
  if (!authRef || !isAbsolute(authRef)) throw new Error('Pass --auth-ref with a read-only existing auth file');
  stage = 'readonly-auth-reference';
  const authPath = await realpath(authRef);
  await access(authPath, constants.R_OK);
  let writable = true;
  try { await access(authPath, constants.W_OK); } catch { writable = false; }
  if (writable) throw new Error('Auth reference must be mounted read-only; existing authentication is never changed');

  stage = 'cli-version';
  const version = execFileSync('codex', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (version !== 'codex-cli 0.154.0') throw new Error('Probe requires codex-cli 0.154.0; inspect the new schema before upgrading');
  report.codex = '0.154.0';
  report.node = process.versions.node;
  stage = 'isolated-state';
  const root = await mkdtemp(join(tmpdir(), 'natsumi-probe-'));
  const cwd = join(root, 'workspace');
  const codexHome = join(root, 'codex');
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(codexHome, { mode: 0o700 });
  await symlink(authPath, join(codexHome, 'auth.json'));
  // Only a filesystem reference is made. The probe never reads or copies tokens.
  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome, LANG: 'C.UTF-8' };
  const startServer = async () => {
    const child = spawn('codex', ['app-server', '--stdio', '-c', 'model_provider="openai"',
      '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"'],
    { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const rpc = new RpcClient(child.stdout, child.stdin);
    child.on('error', () => rpc.close(new Error('App Server failed to start')));
    child.on('exit', () => rpc.close());
    const stop = async () => {
      rpc.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    };
    try {
      await rpc.request('initialize', { clientInfo: { name: 'natsumi_probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      return { rpc, stop };
    } catch (error) { await stop(); throw error; }
  };
  stage = 'initialize';
  let server = await startServer();
  try {
    stage = 'plus-account-check';
    requirePlus(await server.rpc.request('account/read', { refreshToken: false }));
    report.auth = 'chatgpt-plus';
    stage = 'thread-start';
    const started = record(await server.rpc.request('thread/start', {
      cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false, historyMode: 'legacy',
      baseInstructions: 'You are a synthetic protocol test. Follow the user text exactly. Do not use tools or read files.',
      developerInstructions: 'Only return the requested synthetic token. No tools, files, network, or delegation.',
    }));
    const threadId = record(started.thread).id;
    if (typeof threadId !== 'string') throw new Error('Missing thread ID');
    const marker = 'SYNTHETIC-ORCHID-731';
    async function turn(text: string): Promise<string> {
      const result = record(await server.rpc.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] }));
      const id = record(result.turn).id;
      if (typeof id !== 'string') throw new Error('Missing turn ID');
      const completion = await server.rpc.waitFor(event => event.method === 'turn/completed' &&
        record(event.params).threadId === threadId && record(record(event.params).turn).id === id, 120_000);
      if (record(record(completion.params).turn).status !== 'completed') throw new Error('Synthetic turn did not complete');
      return id;
    }
    stage = 'first-response';
    const firstTurn = await turn(`Reply exactly ${marker}`);
    stage = 'thread-read';
    verifyHistory(await server.rpc.request('thread/read', { threadId, includeTurns: true }), threadId, firstTurn, marker);
    report.text = 'start-response-read-passed';
    stage = 'process-restart';
    await server.stop();
    server = await startServer();
    requirePlus(await server.rpc.request('account/read', { refreshToken: false }));
    stage = 'read-after-restart';
    verifyHistory(await server.rpc.request('thread/read', { threadId, includeTurns: true }), threadId, firstTurn, marker);
    stage = 'resume-after-restart';
    verifyHistory(await server.rpc.request('thread/resume', { threadId, cwd, sandbox: 'read-only', approvalPolicy: 'never' }), threadId, firstTurn, marker);
    stage = 'continued-response';
    const secondTurn = await turn('Repeat the synthetic token from the previous assistant response, exactly.');
    const history = await server.rpc.request('thread/read', { threadId, includeTurns: true });
    verifyHistory(history, threadId, firstTurn, marker);
    verifyHistory(history, threadId, secondTurn, marker);
    report.text = 'start-response-read-restart-resume-continue-passed';

    if (values.realtime) {
      stage = 'realtime-list-voices';
      await server.rpc.request('thread/realtime/listVoices', {});
      report.realtimeVoices = 'method-responded';
      stage = 'realtime-start';
      try {
        await server.rpc.request('thread/realtime/start', { threadId, outputModality: 'audio',
          transport: { type: 'websocket' }, includeStartupContext: false,
          prompt: 'This is a synthetic connection test. Say hello briefly. Do not use tools.' });
        report.realtime = 'start-accepted';
        stage = 'realtime-append';
        await server.rpc.request('thread/realtime/appendAudio', { threadId,
          audio: { data: Buffer.alloc(4800).toString('base64'), sampleRate: 24000, numChannels: 1, samplesPerChannel: 2400, itemId: null } });
        report.realtimeInput = 'synthetic-silence-accepted';
        await server.rpc.request('thread/realtime/appendText', { threadId, text: 'Say hello.', role: 'user' });
        stage = 'realtime-output';
        const end = await server.rpc.waitFor(event => event.method.startsWith('thread/realtime/') &&
          record(event.params).threadId === threadId && realtimeOutcome(event) !== 'pending', 45_000);
        report.realtime = realtimeOutcome(end);
        if (end.method === 'thread/realtime/error') {
          report.realtimeErrorCategory = realtimeErrorCategory(end);
          report.realtimeErrorSignals = realtimeErrorSignals(end);
        }
        if (report.realtime !== 'audio-received') process.exitCode = 1;
      } finally {
        await server.rpc.request('thread/realtime/stop', { threadId }, 5000).catch(() => { report.realtimeStop = 'not-confirmed'; });
      }
    }
    stage = 'complete';
  } finally { await server.stop(); }
}

main().catch(error => {
  report.failedStage = stage;
  report.failure = error instanceof RpcError ? `rpc-${error.code}` : 'probe-check-failed';
  // Error messages can contain account identifiers or provider payloads. Never print them.
  process.exitCode = 1;
}).finally(() => process.stdout.write(JSON.stringify(report, null, 2) + '\n'));
