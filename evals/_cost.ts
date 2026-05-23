// Pricing pulled from LiteLLM's community-maintained model catalog at eval-run
// time. Falls back to hardcoded Sonnet 4.x list rates if the fetch fails so
// offline runs still produce a (possibly stale) cost estimate.

const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export interface Rates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  source: 'litellm' | 'fallback';
}

const FALLBACK_RATES: Rates = {
  input: 3.0,
  output: 15.0,
  cacheWrite: 3.75,
  cacheRead: 0.3,
  source: 'fallback',
};

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  litellm_provider?: string;
}

let cached: Promise<Rates> | null = null;

export function getRates(model: string): Promise<Rates> {
  if (!cached) cached = fetchRates(model);
  return cached;
}

async function fetchRates(model: string): Promise<Rates> {
  try {
    const res = await fetch(LITELLM_PRICES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = (await res.json()) as Record<string, LiteLLMEntry>;
    const entry = catalog[model];
    if (!entry) {
      throw new Error(`no entry for "${model}" in LiteLLM catalog`);
    }
    return {
      input: (entry.input_cost_per_token ?? 0) * 1_000_000,
      output: (entry.output_cost_per_token ?? 0) * 1_000_000,
      cacheWrite: (entry.cache_creation_input_token_cost ?? 0) * 1_000_000,
      cacheRead: (entry.cache_read_input_token_cost ?? 0) * 1_000_000,
      source: 'litellm',
    };
  } catch (e) {
    console.warn(
      `[eval cost] using fallback rates (${(e as Error).message}). Update FALLBACK_RATES in evals/_cost.ts if needed.`
    );
    return FALLBACK_RATES;
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

export function costUSD(usage: Usage, rates: Rates): number {
  return (
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheWriteTokens * rates.cacheWrite +
      usage.cacheReadTokens * rates.cacheRead) /
    1_000_000
  );
}

export function formatCost(usage: Usage, rates: Rates): string {
  const suffix = rates.source === 'fallback' ? '*' : '';
  return `$${costUSD(usage, rates).toFixed(4)}${suffix}`;
}
