// Consistent envelope for tools that return a list of items.
// Lets the agent read a one-line summary before deciding whether to enumerate
// the array, and ensures the same shape across tools so the model doesn't
// re-learn the structure per call.
export function envelope(
  summary: string,
  items: unknown[],
  extra?: Record<string, unknown>
): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ summary, items, ...(extra ?? {}) }, null, 2),
      },
    ],
  };
}

export function plural(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}
