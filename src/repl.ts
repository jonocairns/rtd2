import readline from 'node:readline';
import { run } from './agent.js';
import { createConfirmGate } from './confirm.js';
import type { AuditLog } from './audit.js';
import {
  banner,
  PROMPT,
  Spinner,
  renderMarkdown,
  toolCall,
  error,
  usageLine,
  emptyUsage,
  addUsage,
  type TokenUsage,
} from './ui.js';

const TOOL_COUNT = 21;

interface PromptController {
  prompt: AsyncIterable<unknown>;
  allowNextInput: () => void;
}

function createUserPrompt(rl: readline.Interface, spinner: Spinner): PromptController {
  let readyForInput = Promise.resolve();
  let releaseNextInput: (() => void) | null = null;

  async function* prompt() {
    while (true) {
      await readyForInput;
      spinner.stop();

      const line: string = await new Promise((resolve) => rl.question(PROMPT, resolve));
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (trimmed === 'exit' || trimmed === 'quit') return;

      readyForInput = new Promise((resolve) => {
        releaseNextInput = resolve;
      });
      spinner.start();
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: trimmed },
      };
    }
  }

  return {
    prompt: prompt(),
    allowNextInput: () => {
      const release = releaseNextInput;
      releaseNextInput = null;
      release?.();
    },
  };
}

export async function startRepl({
  yolo,
  version,
  audit,
}: {
  yolo: boolean;
  version: string;
  audit: AuditLog;
}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  banner({ version, toolCount: TOOL_COUNT, yolo });

  const spinner = new Spinner();
  const canUseTool = createConfirmGate({ rl, spinner, yolo, audit });
  const userPrompt = createUserPrompt(rl, spinner);

  const session: TokenUsage = emptyUsage();
  let turn: TokenUsage = emptyUsage();

  try {
    for await (const message of run({ prompt: userPrompt.prompt, canUseTool })) {
      if ((message as { type?: string }).type === 'user') turn = emptyUsage();
      const result = handleMessage(message, spinner, audit);
      if (result.usage) {
        turn = addUsage(turn, result.usage);
        Object.assign(session, addUsage(session, result.usage));
      }
      if (result.finalText) {
        usageLine(turn, session);
        userPrompt.allowNextInput();
      }
    }
  } catch (e) {
    spinner.stop();
    error(`Agent error: ${(e as Error).message}`);
  } finally {
    spinner.stop();
    rl.close();
  }
}

interface MessageResult {
  usage: TokenUsage | null;
  finalText: boolean;
}

function handleMessage(message: unknown, spinner: Spinner, audit: AuditLog): MessageResult {
  const none: MessageResult = { usage: null, finalText: false };
  if (typeof message !== 'object' || message === null) return none;
  const m = message as {
    type?: string;
    message?: {
      content?: unknown;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
  };

  if (m.type !== 'assistant') return none;
  // Don't stop the spinner here — it's been running since the user submitted.
  // We stop it inline, just before rendering each block, so there's no gap.

  const raw = m.message?.usage;
  const usage: TokenUsage | null = raw
    ? {
        inputTokens: raw.input_tokens ?? 0,
        outputTokens: raw.output_tokens ?? 0,
        cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
        cacheReadTokens: raw.cache_read_input_tokens ?? 0,
      }
    : null;

  const content = m.message?.content;
  if (!Array.isArray(content)) return { usage, finalText: false };

  let hasText = false;
  let hasTool = false;

  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      spinner.stop();
      console.log(renderMarkdown(block.text));
      hasText = true;
    } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      spinner.stop();
      const displayName = block.name.replace(/^mcp__[^_]+__/, '');
      toolCall(displayName, JSON.stringify(block.input ?? {}));
      audit.append({
        type: 'tool_call',
        ts: new Date().toISOString(),
        tool: displayName,
        args: block.input ?? {},
      });
      hasTool = true;
      spinner.start();
    }
  }

  // Text was shown but more tool calls are coming in the same message.
  if (hasText && hasTool) spinner.restart('processing');

  return { usage, finalText: hasText && !hasTool };
}
