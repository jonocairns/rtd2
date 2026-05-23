import { describe, expect, it } from 'vitest';
import { safe, toolError } from './errors.js';

describe('safe()', () => {
  it('passes through successful results unchanged', async () => {
    const wrapped = safe(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const result = await wrapped({});
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect('isError' in result).toBe(false);
  });

  it('converts thrown errors into isError:true returns', async () => {
    const wrapped = safe(async () => {
      throw new Error('boom');
    });
    const result = await wrapped({});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({ error: 'boom' });
  });

  it('passes the extra arg through without using it', async () => {
    const wrapped = safe(async (args: { x: number }) => ({
      content: [{ type: 'text', text: String(args.x) }],
    }));
    const result = await wrapped({ x: 7 }, { sessionId: 'whatever' });
    expect(result).toEqual({ content: [{ type: 'text', text: '7' }] });
  });

  it('toolError() handles non-Error throws', () => {
    const result = toolError('string error');
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'string error' });
  });
});
