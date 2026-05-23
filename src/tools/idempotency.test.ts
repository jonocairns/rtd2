import { beforeEach, describe, expect, it } from 'vitest';
import {
  once,
  resetIdempotencyForTests,
  setIdempotencyClockForTests,
} from './idempotency.js';

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('once()', () => {
  beforeEach(() => {
    resetIdempotencyForTests();
  });

  it('returns a structured in-flight duplicate without starting a second copy', async () => {
    const pending = deferred<ReturnType<typeof result>>();
    let runs = 0;

    const first = once('tool:1', async () => {
      runs += 1;
      return pending.promise;
    });
    const duplicate = await once('tool:1', async () => {
      runs += 1;
      return result({ shouldNotRun: true });
    });

    expect(runs).toBe(1);
    expect(JSON.parse(duplicate.content[0].text)).toMatchObject({
      idempotent: true,
      duplicate: true,
      status: 'in_flight',
      key: 'tool:1',
    });

    pending.resolve(result({ ok: true }));
    await first;
  });

  it('allows a completed key to run again after TTL expiry', async () => {
    let currentTime = 0;
    setIdempotencyClockForTests(() => currentTime);
    let runs = 0;

    await once('tool:1', async () => {
      runs += 1;
      return result({ run: runs });
    }, { ttlMs: 10 });

    currentTime = 11;

    await once('tool:1', async () => {
      runs += 1;
      return result({ run: runs });
    }, { ttlMs: 10 });

    expect(runs).toBe(2);
  });
});
