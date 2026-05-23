import { describe, expect, it } from 'vitest';
import { overseerr_create_request, overseerr_search } from './overseerr.js';
import { installFetchMock, invoke, route } from './_testing.js';

// Overseerr writes go through a CSRF dance: GET /auth/me for cookies, then the
// real POST. We mock /auth/me with no cookies (empty CSRF still flows).
const authRoute = route('GET', '/api/v1/auth/me', { json: {} });

describe('overseerr_create_request (movie)', () => {
  it('POSTs to /request with the movie body shape', async () => {
    const { calls } = installFetchMock([
      authRoute,
      route('POST', '/api/v1/request', { json: { id: 77, status: 1 } }),
    ]);

    await invoke(overseerr_create_request, { tmdbId: 603, mediaType: 'movie' });

    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    expect(post?.body).toEqual({ mediaId: 603, mediaType: 'movie' });
  });
});

describe('overseerr_create_request (tv)', () => {
  it('includes "all" when no seasons given', async () => {
    const { calls } = installFetchMock([
      authRoute,
      route('POST', '/api/v1/request', { json: { id: 78, status: 1 } }),
    ]);

    await invoke(overseerr_create_request, { tmdbId: 95396, mediaType: 'tv' });

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ mediaId: 95396, mediaType: 'tv', seasons: 'all' });
  });

  it('passes through specific seasons when provided', async () => {
    const { calls } = installFetchMock([
      authRoute,
      route('POST', '/api/v1/request', { json: { id: 79, status: 1 } }),
    ]);

    await invoke(overseerr_create_request, {
      tmdbId: 95396,
      mediaType: 'tv',
      seasons: [1, 2],
    });

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ mediaId: 95396, mediaType: 'tv', seasons: [1, 2] });
  });
});

describe('overseerr_search', () => {
  it('returns the envelope shape with summary and items', async () => {
    installFetchMock([
      route('GET', '/api/v1/search', {
        json: {
          results: [
            {
              id: 603,
              mediaType: 'movie',
              title: 'The Matrix',
              releaseDate: '1999-03-30',
              mediaInfo: { status: 5 },
            },
          ],
        },
      }),
    ]);

    const result = await invoke(overseerr_search, { query: 'matrix' });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);

    expect(parsed.summary).toMatch(/1 match for "matrix"/);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      tmdbId: 603,
      title: 'The Matrix',
      year: '1999',
      libraryStatus: 'available',
    });
  });
});
