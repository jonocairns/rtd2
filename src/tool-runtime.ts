import { tool as aiTool } from 'ai';
import { z } from 'zod';
import type { CanUseTool } from './confirm.js';

export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (input: unknown, extra?: unknown) => Promise<unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export type ToolCallObserver = (event: {
  name: string;
  input: unknown;
}) => void | Promise<void>;

export function textFromToolResult(result: unknown): string {
  if (typeof result !== 'object' || result === null) return String(result);

  const maybe = result as { content?: unknown };
  if (Array.isArray(maybe.content)) {
    return maybe.content
      .map((part) => {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          return String((part as { text: unknown }).text);
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

export function toAiTools(
  descriptors: RuntimeTool[],
  canUseTool: CanUseTool,
  opts?: { onToolCall?: ToolCallObserver }
) {
  return Object.fromEntries(
    descriptors.map((runtimeTool) => [
      runtimeTool.name,
      aiTool({
        description: runtimeTool.description,
        inputSchema: z.object(runtimeTool.inputSchema),
        execute: async (input, extra) => {
          await opts?.onToolCall?.({ name: runtimeTool.name, input });
          if (!runtimeTool.annotations?.readOnlyHint) {
            const decision = await canUseTool(runtimeTool.name, input);
            if (decision.behavior === 'deny') return decision.message;
          }
          return textFromToolResult(await runtimeTool.handler(input, extra));
        },
      }),
    ])
  );
}
