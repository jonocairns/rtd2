export interface ToolErrorResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError: true;
}

export function toolError(e: unknown): ToolErrorResult {
  const err = e as { message?: string };
  const message = err?.message ?? String(e);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message }, null, 2),
      },
    ],
    isError: true,
  };
}

// Wraps an async tool handler so thrown errors return isError:true instead of
// propagating as SDK exceptions. Per Anthropic's tool-use guidance, this lets
// Claude see the failure as part of the tool result and adapt/retry rather
// than halting the agent loop.
export function safe<TArgs, TResult extends { content: unknown[] }>(
  fn: (args: TArgs) => Promise<TResult>
): (args: TArgs, extra?: unknown) => Promise<TResult | ToolErrorResult> {
  return async (args, _extra) => {
    try {
      return await fn(args);
    } catch (e) {
      return toolError(e);
    }
  };
}
