import { vi, type Mock } from 'vitest';

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export function installFetchMock(routes: MockRoute[]): {
  calls: FetchCall[];
  fetchMock: Mock;
} {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body, headers });

    const route = routes.find((r) => r.match(url, init));
    if (!route) {
      throw new Error(`No mock route matched ${method} ${url}`);
    }

    const status = route.status ?? 200;
    const responseBody = route.text ?? (route.json !== undefined ? JSON.stringify(route.json) : '');
    return new Response(responseBody, {
      status,
      headers: { 'Content-Type': 'application/json', ...(route.headers ?? {}) },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
}

// Tool handler signatures treat optional fields as `T | undefined`-required,
// which is annoying in tests. This helper casts at the call site.
export function invoke<T extends { handler: (args: never, extra: unknown) => unknown }>(
  tool: T,
  args: Record<string, unknown>
): ReturnType<T['handler']> {
  return tool.handler(args as never, undefined) as ReturnType<T['handler']>;
}

export function route(
  method: string,
  pathFragment: string,
  response: Omit<MockRoute, 'match'>
): MockRoute {
  return {
    match: (url, init) => {
      const m = (init?.method ?? 'GET').toUpperCase();
      return m === method.toUpperCase() && url.includes(pathFragment);
    },
    ...response,
  };
}
