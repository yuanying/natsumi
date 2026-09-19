/** The longest text one reply or notice may carry. */
export const MAX_OUTPUT_CHARS = 4000;

export type OutputCheck =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'too-long' | 'control' | 'foreign-script'; found?: string[] };

// Chat-template markers that leak when the model's output is parsed out of step (seen in the loop evaluation).
const CONTROL = /<\/?think>|<\/?tool_call>|<\/?tool_response>|<\/?parameter(?:=[^>]*)?>|<\/?function(?:=[^>]*)?>|<\|[a-z_]+\|>/gi;
// C0 controls and DEL, except the tab, carriage return and newline a Markdown file is written with.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/gu;
// Simplified Chinese characters that Japanese text does not use. A heuristic: shared kanji cannot be told apart.
const SIMPLIFIED = /[这个们说还过时见长轻为对问题么东车应该实现开关边话语让给钱认识经处头两发样简洁记忆读书习继续请谢爱门马鱼鸟电脑网务员场钟间业专从众买卖虽节气听视觉须预顺页]/gu;

/**
 * Checks text before it reaches the owner. Nothing that fails is sent: the model is told why and may rewrite it
 * (ADR 0008). Control strings and non-Japanese script are refused rather than warned about, because a sent reply
 * cannot be taken back.
 */
export function checkOutgoingText(text: string): OutputCheck {
  if (text.trim() === '') return { ok: false, reason: 'empty' };
  if ([...text].length > MAX_OUTPUT_CHARS) return { ok: false, reason: 'too-long' };
  const control = findControlStrings(text);
  if (control.length > 0) return { ok: false, reason: 'control', found: control };
  const foreign = findForeignScript(text);
  if (foreign.length > 0) return { ok: false, reason: 'foreign-script', found: foreign };
  return { ok: true };
}

/** Chat-template markers in the text, each once. */
export function findControlStrings(text: string): string[] {
  return unique(text.match(CONTROL));
}

/** True when the text carries a control character. Tab, carriage return and newline are text, not control. */
export function hasControlCharacters(text: string): boolean {
  return CONTROL_CHARACTERS.test(text);
}

/** Hangul and simplified Chinese characters Japanese does not use, each once. */
export function findForeignScript(text: string): string[] {
  return unique([...(text.match(HANGUL) ?? []), ...(text.match(SIMPLIFIED) ?? [])]);
}

/** A sentence for the model saying why the text was not sent. */
export function refusalText(check: Exclude<OutputCheck, { ok: true }>): string {
  switch (check.reason) {
    case 'empty': return '送信していません。本文が空です。';
    case 'too-long': return `送信していません。本文が長すぎます（${MAX_OUTPUT_CHARS} 文字まで）。短くまとめて送り直してください。`;
    case 'control':
      return `送信していません。本文にテンプレートの制御文字列（${check.found!.join(' ')}）が含まれています。制御文字列を除いて書き直してください。`;
    case 'foreign-script':
      return `送信していません。本文に日本語以外の文字（${check.found!.join(' ')}）が含まれています。日本語で書き直してください。`;
  }
}

function unique(values: readonly string[] | null): string[] {
  return [...new Set(values ?? [])];
}
