import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

function withDescription(schema: z.ZodTypeAny, out: JsonSchema): JsonSchema {
  const description = schema.description;
  return description ? { ...out, description } : out;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny; type?: z.ZodTypeAny; values?: string[]; checks?: unknown[] };
  const typeName = def.typeName;

  if (typeName === z.ZodFirstPartyTypeKind.ZodOptional || typeName === z.ZodFirstPartyTypeKind.ZodNullable) {
    return zodToJsonSchema(def.innerType as z.ZodTypeAny);
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
    return withDescription(schema, zodToJsonSchema(def.schema as z.ZodTypeAny));
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodString) {
    return withDescription(schema, { type: 'string' });
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodNumber) {
    return withDescription(schema, { type: 'number' });
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodBoolean) {
    return withDescription(schema, { type: 'boolean' });
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodEnum) {
    return withDescription(schema, { type: 'string', enum: def.values ?? [] });
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodArray) {
    return withDescription(schema, {
      type: 'array',
      items: zodToJsonSchema(def.type as z.ZodTypeAny),
    });
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    const shape = (schema as z.AnyZodObject).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(shape)) {
      const zodChild = child as z.ZodTypeAny;
      properties[key] = zodToJsonSchema(zodChild);
      if (!zodChild.isOptional()) required.push(key);
    }
    return withDescription(schema, {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    });
  }

  return withDescription(schema, {});
}

export function toolInputJsonSchema(inputSchema: Record<string, z.ZodTypeAny>): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(inputSchema)) {
    properties[key] = zodToJsonSchema(schema);
    if (!schema.isOptional()) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
