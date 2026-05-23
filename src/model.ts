import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { env } from './env.js';

export const MODEL =
  env.MODEL_NAME ??
  (env.MODEL_PROVIDER === 'openai' ? 'gpt-5.2' : 'claude-sonnet-4-6');

export function model(): LanguageModel {
  if (env.MODEL_PROVIDER === 'openai') return openai(MODEL);
  return anthropic(MODEL);
}

export function providerOptions() {
  if (env.MODEL_PROVIDER !== 'openai') return undefined;
  return {
    openai: {
      // Existing tool schemas use optional Zod fields heavily. OpenAI strict
      // schemas reject those, so keep compatibility until schemas are
      // normalized per provider.
      strictJsonSchema: false,
      store: false,
    },
  };
}
