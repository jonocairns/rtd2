import { createHash } from 'node:crypto';

export type IdempotencyStatus = 'in_flight' | 'completed' | 'failed';

interface ToolResult {
  content: { type: 'text'; text: string }[];
}

interface IdempotencyEntry<T = unknown> {
  key: string;
  status: IdempotencyStatus;
  startedAt: number;
  completedAt?: number;
  result?: T;
  error?: string;
  promise?: Promise<T>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const registry = new Map<string, IdempotencyEntry>();
let now = () => Date.now();

function duplicateResult(
  key: string,
  status: Extract<IdempotencyStatus, 'in_flight' | 'completed'>,
  result?: unknown
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          status === 'in_flight'
            ? {
                idempotent: true,
                duplicate: true,
                status,
                key,
                message: 'This operation is already in progress; not starting a second copy.',
              }
            : {
                idempotent: true,
                duplicate: true,
                status,
                key,
                result,
              },
          null,
          2
        ),
      },
    ],
  };
}

function pruneExpired(ttlMs: number): void {
  const cutoff = now() - ttlMs;
  for (const [key, entry] of registry) {
    const timestamp = entry.completedAt ?? entry.startedAt;
    if (entry.status !== 'in_flight' && timestamp < cutoff) {
      registry.delete(key);
    }
  }
}

export async function once<T extends ToolResult>(
  key: string,
  fn: () => Promise<T>,
  opts?: { ttlMs?: number }
): Promise<T> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  pruneExpired(ttlMs);

  const existing = registry.get(key) as IdempotencyEntry<T> | undefined;
  if (existing?.status === 'in_flight') {
    return duplicateResult(key, 'in_flight') as T;
  }
  if (
    existing?.status === 'completed' &&
    existing.completedAt !== undefined &&
    now() - existing.completedAt <= ttlMs
  ) {
    return duplicateResult(key, 'completed', existing.result) as T;
  }

  const entry: IdempotencyEntry<T> = {
    key,
    status: 'in_flight',
    startedAt: now(),
  };
  registry.set(key, entry);

  entry.promise = fn();
  try {
    const result = await entry.promise;
    entry.status = 'completed';
    entry.completedAt = now();
    entry.result = result;
    delete entry.promise;
    return result;
  } catch (e) {
    entry.status = 'failed';
    entry.completedAt = now();
    entry.error = e instanceof Error ? e.message : String(e);
    delete entry.promise;
    throw e;
  }
}

export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function resetIdempotencyForTests(): void {
  registry.clear();
  now = () => Date.now();
}

export function setIdempotencyClockForTests(clock: () => number): void {
  now = clock;
}
