import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { env } from '../env.js';

export const MODEL =
  env.MODEL_NAME ??
  (env.MODEL_PROVIDER === 'openai' ? 'gpt-5.2' : 'claude-sonnet-4-6');

function requireModelConfig(): void {
  if (env.MODEL_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when MODEL_PROVIDER=openai');
  }
  if (env.MODEL_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic');
  }
}

export function model(): LanguageModel {
  requireModelConfig();
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
