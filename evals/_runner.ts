import { reportTrace } from 'evalite/traces';
import { run } from '../src/cli/agent.js';
import type { CanUseTool } from '../src/confirm.js';
import type { MockRoute } from '../src/tools/_testing.js';
import { resetDbForTests } from '../src/db.js';
import { resetIdempotencyForTests } from '../src/tools/idempotency.js';
import { addUsage, emptyUsage, type Usage } from './_cost.js';

// Hosts that pass through to real fetch — model APIs + a couple of read-only
// info endpoints. Everything else MUST match a mock route or the call throws.
// This is a safety allowlist: we never want the eval to hit a real Plex /
// Overseerr / Radarr / Sonarr even if env URLs accidentally point there.
const PASS_THROUGH_HOSTS = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'raw.githubusercontent.com', // LiteLLM pricing fetch
]);

export interface ScenarioToolCall {
  name: string;
  input: unknown;
}

export interface ScenarioResult {
  toolCalls: ScenarioToolCall[];
  finalText: string;
  usage: Usage;
  rawMessages: unknown[];
}

export interface ScenarioOptions {
  prompt: string;
  routes: MockRoute[];
  canUseTool?: CanUseTool;
}

export async function runScenario({
  prompt,
  routes,
  canUseTool,
}: ScenarioOptions): Promise<ScenarioResult> {
  const provider = process.env.MODEL_PROVIDER ?? (process.env.OPENAI_API_KEY ? 'openai' : 'anthropic');
  const requiredKey = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const testKey = provider === 'openai' ? 'test-openai-key' : 'test-anthropic-key';
  if (!process.env[requiredKey] || process.env[requiredKey] === testKey) {
    throw new Error(
      `Evals need a real ${requiredKey}. Set it in .env or your shell before running \`pnpm eval\`.`
    );
  }

  const originalFetch = globalThis.fetch;
  const backendCalls: { url: string; method: string }[] = [];
  resetDbForTests(':memory:');
  resetIdempotencyForTests();

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return originalFetch(input as never, init);
    }

    if (PASS_THROUGH_HOSTS.has(hostname)) {
      return originalFetch(input as never, init);
    }

    const method = (init?.method ?? 'GET').toUpperCase();
    backendCalls.push({ url, method });

    const matched = routes.find((r) => r.match(url, init));
    if (!matched) {
      // Fail loudly rather than fall through to real fetch. This is the safety
      // net that prevents evals from mutating live services if env config is
      // misconfigured.
      throw new Error(
        `Eval: blocked unmocked ${method} ${url} (no route matched, host not in PASS_THROUGH_HOSTS)`
      );
    }

    const status = matched.status ?? 200;
    const responseBody =
      matched.text ?? (matched.json !== undefined ? JSON.stringify(matched.json) : '');
    return new Response(responseBody, {
      status,
      headers: { 'Content-Type': 'application/json', ...(matched.headers ?? {}) },
    });
  }) as typeof fetch;

  const toolCalls: ScenarioToolCall[] = [];
  let finalText = '';
  const rawMessages: unknown[] = [];
  let usage: Usage = emptyUsage();

  const promptIterable = (async function* () {
    yield { type: 'user' as const, message: { role: 'user' as const, content: prompt } };
  })();

  const gate: CanUseTool = canUseTool ?? (async () => ({ behavior: 'allow' }));
  const start = Date.now();

  try {
    for await (const message of run({ prompt: promptIterable, canUseTool: gate })) {
      rawMessages.push(message);
      if (message.type === 'usage') {
        usage = addUsage(usage, {
          inputTokens: message.usage.inputTokens ?? 0,
          outputTokens: message.usage.outputTokens ?? 0,
          cacheWriteTokens: message.usage.cacheWriteTokens ?? 0,
          cacheReadTokens: message.usage.cacheReadTokens ?? 0,
        });
      }

      if (message.type === 'tool_call') {
        toolCalls.push({
          name: message.name,
          input: message.input,
        });
      } else if (message.type === 'assistant_text_delta') {
        finalText += message.text;
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Push usage into evalite's trace system so the UI shows tokens + can compute cost.
  reportTrace({
    input: prompt,
    output: finalText,
    start,
    end: Date.now(),
    usage: {
      inputTokens: usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
      totalTokens:
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheWriteTokens +
        usage.cacheReadTokens,
    },
  });

  return { toolCalls, finalText, usage, rawMessages };
}

export function toolNames(result: ScenarioResult): string[] {
  return result.toolCalls.map((c) => c.name);
}
