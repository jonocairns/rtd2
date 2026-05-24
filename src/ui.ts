import { marked, type Tokens } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal({ tab: 0 }) as never);

// marked-terminal v7's `text` renderer returns the raw `text.text` and ignores
// the parsed inline `tokens`, so inline formatting (e.g. **bold**) inside
// tight list items leaks through as literal markdown and ends up on its own
// line. Override `text` to recurse into the inline tokens when present.
marked.use({
  renderer: {
    text(token: Tokens.Text | Tokens.Escape | Tokens.Tag) {
      const innerTokens = (token as Tokens.Text).tokens;
      if (innerTokens && innerTokens.length > 0) {
        return this.parser.parseInline(innerTokens);
      }
      return token.text;
    },
  },
});

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// Rejoin list items the model wrote with the marker on its own line
// (`1.\n**Title** body` becomes `1. **Title** body`) so marked sees a real list.
function repairBrokenLists(text: string): string {
  return text
    .replace(/^([^\S\r\n]*(?:\d+\.|[-*+]))[^\S\r\n]*\r?\n[^\S\r\n]*(?=\S)/gm, '$1 ')
    .replace(/\n{3,}/g, '\n\n');
}

export function renderMarkdown(text: string): string {
  const normalized = repairBrokenLists(text);
  try {
    return String(marked.parse(normalized)).replace(/\n+$/, '');
  } catch {
    return normalized.replace(/\n+$/, '');
  }
}

// Approximate pricing for the default model (USD per million tokens).
// This is only a local display estimate; evals resolve model-specific rates.
const PRICE = {
  input: 1.75,
  output: 14.0,
  cacheWrite: 1.75,
  cacheRead: 0.175,
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

export function costUsd(u: TokenUsage): number {
  return (
    (u.inputTokens * PRICE.input +
      u.outputTokens * PRICE.output +
      u.cacheWriteTokens * PRICE.cacheWrite +
      u.cacheReadTokens * PRICE.cacheRead) /
    1_000_000
  );
}
