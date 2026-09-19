import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PiTarget } from '../pi/session.ts';
import { PiConversation, createPiSession } from './session.ts';

const MARKER = 'SYNTHETIC-ORCHID-731';

type Configure = (session: AgentSession) => void;

/**
 * First round stores a synthetic passphrase. A resumed round must recall it from saved context only;
 * the resume prompt never repeats it, and reply wording is otherwise not judged.
 */
export async function probeRound(root: string, runtime: ModelRuntime, file?: string, configure?: Configure, target?: PiTarget) {
  const session = await createPiSession(root, runtime, file, target);
  try {
    configure?.(session);
    const conversation = new PiConversation(session);
    const stored = () => conversation.history().some(entry => entry.message.role === 'user' &&
      JSON.stringify(entry.message.content).includes(MARKER));
    if (file && !stored()) throw new Error('Saved Pi history missing');
    await conversation.send(file
      ? 'What passphrase did I ask you to remember earlier? Answer with the passphrase only.'
      : `Remember this passphrase for later: ${MARKER}. Reply with just OK.`);
    const last = conversation.history().at(-1);
    if (!stored() || last?.message.role !== 'assistant' ||
      (file && !last.message.content.some(c => c.type === 'text' && c.text.includes(MARKER)))) throw new Error('Pi context check failed');
    if (!session.sessionFile) throw new Error('Pi session was not persisted');
    return { sessionId: session.sessionId, sessionFile: session.sessionFile,
      entryIds: conversation.history().map(entry => entry.id) };
  } finally { await session.abort(); session.dispose(); }
}

/** Asks for a proposal and classifies what the SDK actually executed. Any successful unregistered tool fails. */
export async function probeTool(root: string, runtime: ModelRuntime, configure?: Configure, target?: PiTarget) {
  const session = await createPiSession(root, runtime, undefined, target);
  try {
    configure?.(session);
    await new PiConversation(session).send(
      'Call the calendar_propose tool once with the title "Synthetic planning review". Do not call any other tool.');
    const results = session.messages.filter(m => m.role === 'toolResult');
    if (results.some(r => r.toolName !== 'calendar_propose' && !r.isError)) throw new Error('Pi tool boundary failed');
    if (results.some(r => r.toolName === 'calendar_propose' && !r.isError && JSON.stringify(r.content).includes('pending-approval'))) {
      return 'proposal-pending-approval' as const;
    }
    return results.some(r => r.isError) ? 'unregistered-tool-refused' as const : 'not-called' as const;
  } finally { await session.abort(); session.dispose(); }
}
