import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { AgentSession, createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime,
  SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

/** A model inside Pi. Choosing one selects where Pi sends requests; it is not a backend switch. */
export interface PiTarget { provider: string; model: string }

// Pi subscription provider and its default model in Pi 0.85.1, not a separate agent backend.
export const SUBSCRIPTION_TARGET: PiTarget = { provider: 'openai-codex', model: 'gpt-5.5' };

// A fixture proposal only: it has no Google client, credentials, or write callback.
export const proposalTool = defineTool({
  name: 'calendar_propose', label: 'Propose a calendar change',
  description: 'Prepare a fictional proposal for human approval. Does not write to Calendar.',
  parameters: Type.Object({ title: Type.String() }),
  execute: async (_id, params) => ({ content: [{ type: 'text' as const, text: 'pending-approval' }],
    details: { title: params.title, status: 'pending-approval' } }),
});

type CreateOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
export type PiThinkingLevel = NonNullable<CreateOptions['thinkingLevel']>;

/** A saved session could not be restored. It is never replaced by a new session. */
export class PiSessionRestoreError extends Error {
  constructor(message: string) { super(message); this.name = 'PiSessionRestoreError'; }
}

export interface PiSessionOptions {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  modelRuntime: ModelRuntime;
  target: PiTarget;
  systemPrompt: string;
  thinkingLevel: PiThinkingLevel;
  /** A saved session file to restore. */
  file?: string;
  /** The session ID the caller recorded for `file`. */
  expectedSessionId?: string;
  /** The tool allowlist and its definitions. Without it Pi has no tools at all (ADR 0004). */
  tools?: { names: string[]; definitions: CreateOptions['customTools'] };
}

/**
 * The header session ID of a saved session. Every non-empty line must be JSON: Pi skips malformed lines when it
 * loads, which must not count as a successful restore (ADR 0001).
 */
export async function readSessionId(file: string): Promise<string> {
  try {
    const entries = (await readFile(file, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const header = entries[0];
    if (header.type !== 'session' || typeof header.id !== 'string') throw new Error();
    return header.id;
  } catch { throw new PiSessionRestoreError('Missing or invalid Pi session'); }
}

/** One Pi integration boundary. No backend registry or alternate adapter. */
export async function openPiSession(options: PiSessionOptions): Promise<AgentSession> {
  const { cwd, agentDir, sessionDir, modelRuntime, target, file } = options;
  let expectedId: string | undefined;
  if (file) {
    // SessionManager.open can create a new session for a nonexistent/invalid file.
    // Fail closed before calling it so a lost conversation is never silently replaced.
    expectedId = await readSessionId(file);
    if (options.expectedSessionId !== undefined && options.expectedSessionId !== expectedId) {
      throw new PiSessionRestoreError('Pi session identity mismatch');
    }
  }
  const model = modelRuntime.getModel(target.provider, target.model);
  if (!model) throw new Error('Pinned Pi model unavailable');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: options.systemPrompt,
  });
  await resourceLoader.reload();
  const { session, modelFallbackMessage } = await createAgentSession({ cwd, agentDir, modelRuntime, model,
    sessionManager: file ? SessionManager.open(file, sessionDir, cwd) : SessionManager.create(cwd, sessionDir),
    settingsManager, resourceLoader, tools: options.tools?.names ?? [], customTools: options.tools?.definitions ?? [],
    thinkingLevel: options.thinkingLevel,
  });
  if (expectedId && session.sessionId !== expectedId) {
    session.dispose(); throw new PiSessionRestoreError('Pi session identity mismatch');
  }
  if (modelFallbackMessage || session.model?.provider !== target.provider || session.model.id !== target.model) {
    session.dispose(); throw new Error('Pi model fallback refused');
  }
  return session;
}

/**
 * A new session whose file exists from the start. Pi itself writes a session file only after the first assistant
 * reply, so a stop before that would leave a recorded reference to a missing file. The header is written here and the
 * session is then opened through the same checks as any restore.
 */
export async function createPersistedPiSession(options: Omit<PiSessionOptions, 'file' | 'expectedSessionId'>): Promise<AgentSession> {
  if (!options.modelRuntime.getModel(options.target.provider, options.target.model)) throw new Error('Pinned Pi model unavailable');
  const manager = SessionManager.create(options.cwd, options.sessionDir);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error('Pi session was not persisted');
  await writeFile(file, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 });
  return openPiSession({ ...options, file, expectedSessionId: header.id });
}

/** The isolated probe harness: a private root, a synthetic instruction and only the proposal fixture tool. */
export async function createPiSession(root: string, modelRuntime: ModelRuntime, file?: string,
  target: PiTarget = SUBSCRIPTION_TARGET): Promise<AgentSession> {
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'pi');
  const sessionDir = join(root, 'sessions');
  for (const path of [cwd, agentDir, sessionDir]) await mkdir(path, { recursive: true, mode: 0o700 });
  return openPiSession({ cwd, agentDir, sessionDir, modelRuntime, target, file, thinkingLevel: 'off',
    systemPrompt: 'You are a synthetic protocol test. Use only the supplied messages. Do not access files or external tools.',
    tools: { names: ['calendar_propose'], definitions: [proposalTool] },
  });
}

export class PiConversation {
  private session: AgentSession;
  private busy = false;
  constructor(session: AgentSession) { this.session = session; }

  history() {
    return this.session.sessionManager.getBranch().filter(entry => entry.type === 'message');
  }

  async send(text: string, timeout = 120_000): Promise<void> {
    if (this.busy) throw new Error('Pi conversation busy');
    this.busy = true;
    let expired = false;
    const timer = setTimeout(() => { expired = true; void this.session.abort(); }, timeout);
    const before = this.session.messages.length;
    try {
      await this.session.prompt(text, { expandPromptTemplates: false });
      if (expired) throw new Error('Pi response timeout');
      const reply = this.session.messages.slice(before).filter(m => m.role === 'assistant').at(-1);
      if (!reply || reply.role !== 'assistant' || reply.stopReason !== 'stop') throw new Error('Pi response failed');
    } catch {
      throw new Error(expired ? 'Pi response timeout' : 'Pi response failed');
    } finally { clearTimeout(timer); this.busy = false; }
  }
}
