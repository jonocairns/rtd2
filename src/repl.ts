import readline from 'node:readline';
import { run, type AgentEvent } from './agent.js';
import { createConfirmGate } from './confirm.js';
import type { AuditLog } from './audit.js';
import type { SubagentEvent } from './investigator.js';
import { baseToolDescriptors } from './tool-registry.js';
import {
  banner,
  PROMPT,
  Spinner,
  renderMarkdown,
  toolCall,
  subagentStart,
  subagentToolCall,
  subagentDone,
  subagentError,
  error,
  usageLine,
  emptyUsage,
  addUsage,
  type TokenUsage,
} from './ui.js';

const TOOL_COUNT = baseToolDescriptors.length + 1; // + media_investigate

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

      // rl.question auto-resumes the interface. We pause again immediately
      // after the line resolves so keystrokes typed while the agent runs are
      // buffered (and don't get echoed interleaved with streaming output);
      // they get flushed cleanly into the next prompt instead.
      const line: string = await new Promise((resolve) => rl.question(PROMPT, resolve));
      rl.pause();
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
  // Start paused — `rl.question` auto-resumes when we want input, and we
  // re-pause as soon as the line resolves so input doesn't get captured /
  // echoed while the agent is streaming output.
  rl.pause();

  banner({ version, toolCount: TOOL_COUNT, yolo });

  const spinner = new Spinner();
  const canUseTool = createConfirmGate({ rl, spinner, yolo, audit });
  const userPrompt = createUserPrompt(rl, spinner);

  const session: TokenUsage = emptyUsage();
  let turn: TokenUsage = emptyUsage();
  let pendingText = '';

  try {
    const textBuffer: TextBuffer = {
      get pendingText() {
        return pendingText;
      },
      set pendingText(text: string) {
        pendingText = text;
      },
    };
    const onSubagentEvent = (event: SubagentEvent) => {
      renderSubagentEvent(event, spinner, textBuffer);
      if (event.type === 'tool_call') {
        audit.append({
          type: 'tool_call',
          ts: new Date().toISOString(),
          tool: `subagent#${event.id}:${event.name}`,
          args: event.input ?? {},
        });
      }
    };

    for await (const event of run({ prompt: userPrompt.prompt, canUseTool, onSubagentEvent })) {
      if (event.type === 'user') {
        turn = emptyUsage();
        pendingText = '';
      }
      const result = handleEvent(event, spinner, audit, textBuffer);
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

function flushPendingText(textBuffer: TextBuffer) {
  if (textBuffer.pendingText.trim() !== '') {
    console.log(renderMarkdown(textBuffer.pendingText));
    textBuffer.pendingText = '';
  }
}

function renderSubagentEvent(
  event: SubagentEvent,
  spinner: Spinner,
  textBuffer: TextBuffer
) {
  spinner.stop();
  flushPendingText(textBuffer);

  switch (event.type) {
    case 'start':
      subagentStart(event.id, event.task);
      break;
    case 'tool_call':
      subagentToolCall(event.id, event.name, JSON.stringify(event.input ?? {}));
      break;
    case 'done':
      subagentDone(event.id, event.toolCallCount);
      break;
    case 'error':
      subagentError(event.id, event.message);
      break;
  }

  spinner.start('processing');
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
      flushPendingText(textBuffer);
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
      flushPendingText(textBuffer);
      return { usage: null, finalText: true };
    case 'user':
      return none;
  }
}
