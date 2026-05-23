import type { Evalite } from 'evalite';
import { MODEL } from '../src/agent.js';
import { formatCost, getRates } from './_cost.js';
import type { ScenarioResult } from './_runner.js';

// Custom columns surfaced in the evalite UI + terminal table.
// Cost rates are fetched from LiteLLM on first call and cached.
// A trailing "*" on the cost means we fell back to hardcoded rates.
export function agentColumns(): (
  opts: Evalite.ColumnInput<unknown, ScenarioResult, unknown>
) => Promise<Evalite.RenderedColumn[]> {
  return async ({ output }) => {
    const rates = await getRates(MODEL);
    return [
      {
        label: 'tools',
        value: output.toolCalls.map((c) => c.name).join(' → ') || '(none)',
      },
      { label: 'tokens', value: output.usage.inputTokens + output.usage.outputTokens },
      { label: 'cost', value: formatCost(output.usage, rates) },
    ];
  };
}
