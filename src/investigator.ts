import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import { model, providerOptions } from './cli/model.js';
import { readOnlyToolDescriptors } from './tool-registry.js';
import { toAiTools, type RuntimeTool } from './tool-runtime.js';
import { tool } from './tools/define.js';
import { safe } from './tools/errors.js';

const INVESTIGATOR_PROMPT = `You are a read-only media investigation sub-agent.

Your job is to gather facts with read-only tools and return a concise JSON object.
You must not claim to have changed anything. You cannot execute mutating actions.
For file-quality investigations, use plex_quality_audit for library-wide checks and plex_search -> plex_quality_profile for a named title.

Return JSON with this shape:
{
  "summary": "one short paragraph",
  "facts": [{ "sourceTool": "tool_name", "claim": "grounded fact" }],
  "proposedActions": [
    {
      "tool": "mutating_tool_name_or_read_only_followup",
      "args": {},
      "risk": "none" | "low" | "destructive",
      "reason": "why this action follows from the facts"
    }
  ],
  "questions": ["only include questions needed before a write or disambiguation"]
}

Prefer proposing actions over executing them. If the user intent is already answerable with read-only facts, leave proposedActions empty.`;

function summarizeToolCalls(result: { steps: Array<{ toolCalls: unknown[] }> }) {
  return result.steps.flatMap((step) =>
    step.toolCalls.map((raw) => {
      const call = raw as { toolName?: unknown; input?: unknown };
      return {
        name: String(call.toolName),
        input: call.input,
      };
    })
  );
}

export type SubagentEvent =
  | { type: 'start'; id: number; name: 'media_investigate'; task: string }
  | { type: 'tool_call'; id: number; name: string; input: unknown }
  | { type: 'done'; id: number; toolCallCount: number }
  | { type: 'error'; id: number; message: string };

export type SubagentObserver = (event: SubagentEvent) => void | Promise<void>;

let nextSubagentId = 1;

export async function investigateMediaTask(
  task: string,
  onEvent?: SubagentObserver
): Promise<{
  content: { type: 'text'; text: string }[];
}> {
  const id = nextSubagentId++;
  let toolCallCount = 0;
  await onEvent?.({ type: 'start', id, name: 'media_investigate', task });

  let result: { steps: Array<{ toolCalls: unknown[] }>; text: string };
  try {
    result = await generateText({
      model: model(),
      system: INVESTIGATOR_PROMPT,
      prompt: task,
      tools: toAiTools(
        readOnlyToolDescriptors as RuntimeTool[],
        async () => ({ behavior: 'allow' }),
        {
          onToolCall: async (event) => {
            toolCallCount += 1;
            await onEvent?.({ type: 'tool_call', id, name: event.name, input: event.input });
          },
        }
      ),
      stopWhen: stepCountIs(10),
      providerOptions: providerOptions(),
    });
  } catch (e) {
    await onEvent?.({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  await onEvent?.({ type: 'done', id, toolCallCount });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            investigator: true,
            toolCalls: summarizeToolCalls(result),
            result: result.text,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function createMediaInvestigateTool(onEvent?: SubagentObserver): RuntimeTool {
  return tool(
    'media_investigate',
    'Read-only sub-agent for broad media investigations. It can search, inspect requests, check streaming availability, inspect Plex library state, and return grounded facts plus proposed actions. Use for ambiguous or multi-step investigation before deciding whether to call mutating tools; do not use for simple one-tool lookups.',
    {
      task: z.string().min(1).describe('The investigation task to perform. Include the user intent and any known context.'),
    },
    safe(async ({ task }) => investigateMediaTask(task, onEvent)),
    { annotations: { readOnlyHint: true } }
  ) as RuntimeTool;
}

export const media_investigate = createMediaInvestigateTool();
