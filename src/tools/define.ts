import type { z } from 'zod';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
}

export interface ToolDescriptor<
  TSchema extends Record<string, z.ZodTypeAny>,
  TResult,
> {
  name: string;
  description: string;
  inputSchema: TSchema;
  handler: (input: z.infer<z.ZodObject<TSchema>>, extra?: unknown) => Promise<TResult>;
  annotations?: ToolAnnotations;
}

export function tool<TSchema extends Record<string, z.ZodTypeAny>, TResult>(
  name: string,
  description: string,
  inputSchema: TSchema,
  handler: (input: z.infer<z.ZodObject<TSchema>>, extra?: unknown) => Promise<TResult>,
  opts?: { annotations?: ToolAnnotations }
): ToolDescriptor<TSchema, TResult> {
  return {
    name,
    description,
    inputSchema,
    handler,
    annotations: opts?.annotations,
  };
}

