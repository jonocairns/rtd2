import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import { model, providerOptions } from './model.js';
import { readOnlyToolDescriptors } from './tool-registry.js';
import { toAiTools, type RuntimeTool } from './tool-runtime.js';
import { tool } from './tools/define.js';
import { safe } from './tools/errors.js';

const INVESTIGATOR_PROMPT = `You are a read-only media investigation sub-agent.

Your job is to gather facts with read-only tools and return a concise JSON object.
You must not claim to have changed anything. You cannot execute mutating actions.

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

export async function investigateMediaTask(task: string): Promise<{
  content: { type: 'text'; text: string }[];
}> {
  const result = await generateText({
    model: model(),
    system: INVESTIGATOR_PROMPT,
    prompt: task,
    tools: toAiTools(readOnlyToolDescriptors as RuntimeTool[], async () => ({ behavior: 'allow' })),
    stopWhen: stepCountIs(10),
    providerOptions: providerOptions(),
  });

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

export const media_investigate = tool(
  'media_investigate',
  'Read-only sub-agent for broad media investigations. It can search, inspect requests, check streaming availability, inspect Plex library state, and return grounded facts plus proposed actions. Use for ambiguous or multi-step investigation before deciding whether to call mutating tools; do not use for simple one-tool lookups.',
  {
    task: z.string().min(1).describe('The investigation task to perform. Include the user intent and any known context.'),
  },
  safe(async ({ task }) => investigateMediaTask(task)),
  { annotations: { readOnlyHint: true } }
);
