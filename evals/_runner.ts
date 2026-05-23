import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { reportTrace } from 'evalite/traces';
import { run } from '../src/agent.js';
import type { MockRoute } from '../src/tools/_testing.js';
import { addUsage, emptyUsage, type Usage } from './_cost.js';

// Hosts that pass through to real fetch — Claude API + a couple of read-only
// info endpoints. Everything else MUST match a mock route or the call throws.
// This is a safety allowlist: we never want the eval to hit a real Plex /
// Overseerr / Radarr / Sonarr even if env URLs accidentally point there.
const PASS_THROUGH_HOSTS = new Set([
  'api.anthropic.com',
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
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'test-anthropic-key') {
    throw new Error(
      'Evals need a real ANTHROPIC_API_KEY. Set it in .env or your shell before running `pnpm eval`.'
    );
  }

  const originalFetch = globalThis.fetch;
  const backendCalls: { url: string; method: string }[] = [];

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
      const m = message as {
        type?: string;
        message?: {
          content?: unknown;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
      };

      const raw = m.message?.usage;
      if (raw) {
        usage = addUsage(usage, {
          inputTokens: raw.input_tokens ?? 0,
          outputTokens: raw.output_tokens ?? 0,
          cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
          cacheReadTokens: raw.cache_read_input_tokens ?? 0,
        });
      }

      if (m.type !== 'assistant') continue;
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          toolCalls.push({
            name: block.name.replace(/^mcp__[^_]+__/, ''),
            input: block.input,
          });
        } else if (block?.type === 'text' && typeof block.text === 'string') {
          finalText += block.text;
        }
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
