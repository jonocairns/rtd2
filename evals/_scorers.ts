import { createScorer } from 'evalite';
import type { ScenarioResult } from './_runner.js';

type ScenarioInput = unknown;

// Returns 1 when every named tool appears somewhere in the call sequence.
export function containsTools(...expected: string[]) {
  return createScorer<ScenarioInput, ScenarioResult>({
    name: `contains: ${expected.join(', ')}`,
    scorer: ({ output }) => {
      const names = output.toolCalls.map((c) => c.name);
      const missing = expected.filter((t) => !names.includes(t));
      return {
        score: missing.length === 0 ? 1 : 0,
        metadata: { actual: names, missing },
      };
    },
  });
}

// Returns 1 when `before` appears in the trace strictly before `after`.
export function toolOrder(before: string, after: string) {
  return createScorer<ScenarioInput, ScenarioResult>({
    name: `${before} before ${after}`,
    scorer: ({ output }) => {
      const names = output.toolCalls.map((c) => c.name);
      const a = names.indexOf(before);
      const b = names.indexOf(after);
      const ok = a !== -1 && b !== -1 && a < b;
      return {
        score: ok ? 1 : 0,
        metadata: { sequence: names },
      };
    },
  });
}

// Returns 1 when the assistant's final text contains the given phrase (case-insensitive).
export function finalTextIncludes(phrase: string) {
  return createScorer<ScenarioInput, ScenarioResult>({
    name: `final text mentions "${phrase}"`,
    scorer: ({ output }) => ({
      score: output.finalText.toLowerCase().includes(phrase.toLowerCase()) ? 1 : 0,
      metadata: { finalText: output.finalText },
    }),
  });
}

// Returns 1 when the assistant's final text contains AT LEAST one of the given phrases.
export function finalTextIncludesAny(...phrases: string[]) {
  return createScorer<ScenarioInput, ScenarioResult>({
    name: `final text mentions one of [${phrases.join(', ')}]`,
    scorer: ({ output }) => {
      const text = output.finalText.toLowerCase();
      const hit = phrases.find((p) => text.includes(p.toLowerCase()));
      return {
        score: hit ? 1 : 0,
        metadata: { matched: hit ?? null, finalText: output.finalText },
      };
    },
  });
}

// Returns 1 when the tool call with `name` was invoked with input that satisfies a predicate.
export function toolInputMatches<TName extends string>(
  name: TName,
  predicate: (input: unknown) => boolean
) {
  return createScorer<ScenarioInput, ScenarioResult>({
    name: `${name} input matches predicate`,
    scorer: ({ output }) => {
      const call = output.toolCalls.find((c) => c.name === name);
      return {
        score: call && predicate(call.input) ? 1 : 0,
        metadata: { actual: call?.input ?? null },
      };
    },
  });
}
