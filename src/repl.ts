import readline from 'node:readline';
import { run, type AgentEvent } from './agent.js';
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

const TOOL_COUNT = 24;

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
  let pendingText = '';

  try {
    for await (const event of run({ prompt: userPrompt.prompt, canUseTool })) {
      if (event.type === 'user') {
        turn = emptyUsage();
        pendingText = '';
      }
      const result = handleEvent(event, spinner, audit, {
        get pendingText() {
          return pendingText;
        },
        set pendingText(text: string) {
          pendingText = text;
        },
      });
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

interface TextBuffer {
  pendingText: string;
}

function handleEvent(
  event: AgentEvent,
  spinner: Spinner,
  audit: AuditLog,
  textBuffer: TextBuffer
): MessageResult {
  const none: MessageResult = { usage: null, finalText: false };

  switch (event.type) {
    case 'assistant_text_delta':
      textBuffer.pendingText += event.text;
      return none;
    case 'tool_call':
      spinner.stop();
      if (textBuffer.pendingText.trim() !== '') {
        console.log(renderMarkdown(textBuffer.pendingText));
        textBuffer.pendingText = '';
      }
      toolCall(event.name, JSON.stringify(event.input ?? {}));
      audit.append({
        type: 'tool_call',
        ts: new Date().toISOString(),
        tool: event.name,
        args: event.input ?? {},
      });
      spinner.start('processing');
      return none;
    case 'usage':
      return {
        usage: {
          inputTokens: event.usage.inputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
          cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
          cacheReadTokens: event.usage.cacheReadTokens ?? 0,
        },
        finalText: false,
      };
    case 'assistant_done':
      spinner.stop();
      if (textBuffer.pendingText.trim() !== '') {
        console.log(renderMarkdown(textBuffer.pendingText));
        textBuffer.pendingText = '';
      }
      return { usage: null, finalText: true };
    case 'user':
      return none;
  }
}
