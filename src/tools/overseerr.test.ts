import { beforeEach, describe, expect, it } from 'vitest';
import {
  overseerr_approve_request,
  overseerr_cancel_request,
  overseerr_create_request,
  overseerr_delete_request,
  overseerr_discover,
  overseerr_discover_hidden_gems,
  overseerr_get_request,
  overseerr_list_requests,
  overseerr_person_credits,
  overseerr_reject_request,
  overseerr_report_issue,
  overseerr_search,
} from './overseerr.js';
import { installFetchMock, invoke, route, routeSequence } from './_testing.js';
import { resetIdempotencyForTests } from './idempotency.js';
import { resetDbForTests } from '../db.js';

// Overseerr writes go through a CSRF dance: GET /auth/me for cookies, then the
// real POST. We mock /auth/me with no cookies (empty CSRF still flows).
const authRoute = route('GET', '/api/v1/auth/me', { json: {} });
const missingMovieRoute = route('GET', '/api/v1/movie/603', { json: { mediaInfo: { status: 1 } } });
const missingTvRoute = route('GET', '/api/v1/tv/95396', { json: { mediaInfo: { status: 1 } } });

beforeEach(() => {
  resetIdempotencyForTests();
  resetDbForTests(':memory:');
});

describe('overseerr_create_request (movie)', () => {
  it('POSTs to /request with the movie body shape', async () => {
    const { calls } = installFetchMock([
      missingMovieRoute,
      authRoute,
      route('POST', '/api/v1/request', { json: { id: 77, status: 1 } }),
    ]);

    await invoke(overseerr_create_request, { tmdbId: 603, mediaType: 'movie' });

    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    expect(post?.body).toEqual({ mediaId: 603, mediaType: 'movie' });
  });

  it('does not POST twice for duplicate same-arg calls', async () => {
    const { calls } = installFetchMock([
      missingMovieRoute,
      authRoute,
      route('POST', '/api/v1/request', { json: { id: 77, status: 1 } }),
    ]);

    await invoke(overseerr_create_request, { tmdbId: 603, mediaType: 'movie' });
    const duplicate = await invoke(overseerr_create_request, { tmdbId: 603, mediaType: 'movie' });

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const parsed = JSON.parse((duplicate.content[0] as { text: string }).text);
    expect(parsed).toMatchObject({
      idempotent: true,
      duplicate: true,
      status: 'completed',
      key: 'overseerr_create_request:movie:603:all',
    });
  });
});

describe('overseerr_create_request (tv)', () => {
  it('includes "all" when no seasons given', async () => {
    const { calls } = installFetchMock([
      missingTvRoute,
      authRoute,
      route('POST', '/api/v1/request', { json: { id: 78, status: 1 } }),
    ]);

    await invoke(overseerr_create_request, { tmdbId: 95396, mediaType: 'tv' });

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ mediaId: 95396, mediaType: 'tv', seasons: 'all' });
  });

  it('passes through specific seasons when provided', async () => {
    const { calls } = installFetchMock([
      missingTvRoute,
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

  it('runs materially different season requests separately', async () => {
    const { calls } = installFetchMock([
      missingTvRoute,
      authRoute,
      route('POST', '/api/v1/request', { json: { id: 79, status: 1 } }),
    ]);

    await invoke(overseerr_create_request, {
      tmdbId: 95396,
      mediaType: 'tv',
      seasons: [1],
    });
    await invoke(overseerr_create_request, {
      tmdbId: 95396,
      mediaType: 'tv',
      seasons: [2],
    });

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });
});

describe('overseerr schema aliases', () => {
  it('accepts show/series aliases for mediaType', async () => {
    const { calls } = installFetchMock([
      missingTvRoute,
      authRoute,
      route('POST', '/api/v1/request', { json: { id: 78, status: 1 } }),
    ]);

    await invoke(overseerr_create_request, { tmdbId: 95396, mediaType: 'show' });

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ mediaId: 95396, mediaType: 'tv', seasons: 'all' });
  });

  it('accepts subtitles as an issueType alias', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/movie/603', { json: { mediaInfo: { id: 44 } } }),
      authRoute,
      route('POST', '/api/v1/issue', { json: { id: 90 } }),
    ]);

    await invoke(overseerr_report_issue, {
      tmdbId: 603,
      mediaType: 'movie',
      issueType: 'subtitles',
      message: 'Missing English subtitles',
    });

    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      mediaId: 44,
      issueType: 3,
    });
  });

  it('accepts director as a person credits role alias', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/person/1/combined_credits', {
        json: {
          crew: [
            {
              id: 603,
              media_type: 'movie',
              title: 'The Matrix',
              release_date: '1999-03-30',
              department: 'Directing',
              job: 'Director',
            },
          ],
        },
      }),
    ]);

    const result = await invoke(overseerr_person_credits, { personId: 1, role: 'director' });

    expect(calls).toHaveLength(1);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.items[0]).toMatchObject({ title: 'The Matrix', role: 'Director' });
  });
});

describe('overseerr request moderation', () => {
  it('lists requests with filter + take', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/request', {
        json: {
          results: [
            {
              id: 12,
              status: 1,
              createdAt: '2026-05-23T00:00:00Z',
              updatedAt: '2026-05-23T00:00:00Z',
              type: 'movie',
              is4k: false,
              media: {
                tmdbId: 603,
                status: 2,
                mediaType: 'movie',
                title: 'The Matrix',
                releaseDate: '1999-03-30',
              },
            },
          ],
        },
      }),
    ]);

    const result = await invoke(overseerr_list_requests, { status: 'pending', take: 10 });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/request');
    expect(url.searchParams.get('filter')).toBe('pending');
    expect(url.searchParams.get('take')).toBe('10');

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.items[0]).toMatchObject({
      id: 12,
      tmdbId: 603,
      title: 'The Matrix',
      year: '1999',
      requestStatus: 'pending approval',
      mediaStatus: 'pending',
    });
  });

  it('treats status=all as an unfiltered request list', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/request', { json: { results: [] } }),
    ]);

    const result = await invoke(overseerr_list_requests, { status: 'all', take: 20 });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/request');
    expect(url.searchParams.get('take')).toBe('20');
    expect(url.searchParams.has('filter')).toBe(false);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.summary).toBe('0 requests');
  });

  it('enriches request titles from media detail and reuses the local database', async () => {
    const requestPayload = {
      results: [
        {
          id: 12,
          status: 1,
          createdAt: '2026-05-23T00:00:00Z',
          updatedAt: '2026-05-23T00:00:00Z',
          type: 'movie',
          is4k: false,
          media: { tmdbId: 603, status: 2, mediaType: 'movie' },
        },
      ],
    };
    const { calls } = installFetchMock([
      route('GET', '/api/v1/request', { json: requestPayload }),
      route('GET', '/api/v1/movie/603', {
        json: { title: 'The Matrix', releaseDate: '1999-03-30' },
      }),
    ]);

    const first = await invoke(overseerr_list_requests, { take: 20 });
    const second = await invoke(overseerr_list_requests, { take: 20 });

    expect(calls.filter((c) => new URL(c.url).pathname === '/api/v1/movie/603')).toHaveLength(1);
    for (const result of [first, second]) {
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.items[0]).toMatchObject({ title: 'The Matrix', year: '1999' });
    }
  });

  it('deduplicates title enrichment calls for repeated TMDb IDs in one list', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/request', {
        json: {
          results: [
            {
              id: 12,
              status: 1,
              createdAt: '2026-05-23T00:00:00Z',
              updatedAt: '2026-05-23T00:00:00Z',
              type: 'movie',
              is4k: false,
              media: { tmdbId: 603, status: 2, mediaType: 'movie' },
            },
            {
              id: 13,
              status: 2,
              createdAt: '2026-05-23T00:00:00Z',
              updatedAt: '2026-05-23T00:00:00Z',
              type: 'movie',
              is4k: false,
              media: { tmdbId: 603, status: 3, mediaType: 'movie' },
            },
          ],
        },
      }),
      route('GET', '/api/v1/movie/603', {
        json: { title: 'The Matrix', releaseDate: '1999-03-30' },
      }),
    ]);

    const result = await invoke(overseerr_list_requests, { take: 20 });

    expect(calls.filter((c) => new URL(c.url).pathname === '/api/v1/movie/603')).toHaveLength(1);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.items.map((i: { title: string }) => i.title)).toEqual([
      'The Matrix',
      'The Matrix',
    ]);
  });

  it('continues listing requests when one title enrichment lookup fails', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/request', {
        json: {
          results: [
            {
              id: 12,
              status: 1,
              createdAt: '2026-05-23T00:00:00Z',
              updatedAt: '2026-05-23T00:00:00Z',
              type: 'movie',
              is4k: false,
              media: { tmdbId: 603, status: 2, mediaType: 'movie' },
            },
            {
              id: 14,
              status: 1,
              createdAt: '2026-05-23T00:00:00Z',
              updatedAt: '2026-05-23T00:00:00Z',
              type: 'movie',
              is4k: false,
              media: { tmdbId: 999, status: 2, mediaType: 'movie' },
            },
          ],
        },
      }),
      route('GET', '/api/v1/movie/603', {
        json: { title: 'The Matrix', releaseDate: '1999-03-30' },
      }),
      route('GET', '/api/v1/movie/999', { status: 500, text: 'nope' }),
    ]);

    const result = await invoke(overseerr_list_requests, { take: 20 });

    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.items).toEqual([
      expect.objectContaining({ tmdbId: 603, title: 'The Matrix' }),
      expect.objectContaining({ tmdbId: 999, title: null }),
    ]);
  });

  it('stores embedded request titles for later enrichment', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/request/13', {
        json: {
          id: 13,
          status: 2,
          createdAt: '2026-05-23T00:00:00Z',
          updatedAt: '2026-05-23T00:00:00Z',
          type: 'movie',
          is4k: false,
          media: { tmdbId: 603, status: 3, mediaType: 'movie' },
        },
      }),
      route('GET', '/api/v1/request', {
        json: {
          results: [
            {
              id: 12,
              status: 1,
              createdAt: '2026-05-23T00:00:00Z',
              updatedAt: '2026-05-23T00:00:00Z',
              type: 'movie',
              is4k: false,
              media: {
                tmdbId: 603,
                status: 2,
                mediaType: 'movie',
                title: 'The Matrix',
                releaseDate: '1999-03-30',
              },
            },
          ],
        },
      }),
    ]);

    await invoke(overseerr_list_requests, { take: 20 });
    const result = await invoke(overseerr_get_request, { id: 13 });

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/api/v1/request',
      '/api/v1/request/13',
    ]);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      title: 'The Matrix',
      year: '1999',
    });
  });

  it('enriches request detail with a stored title', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/request/12', {
        json: {
          id: 12,
          status: 1,
          createdAt: '2026-05-23T00:00:00Z',
          updatedAt: '2026-05-23T00:00:00Z',
          type: 'tv',
          is4k: false,
          media: { tmdbId: 95396, status: 2, mediaType: 'tv' },
        },
      }),
      route('GET', '/api/v1/tv/95396', {
        json: { name: 'Severance', firstAirDate: '2022-02-18' },
      }),
    ]);

    const result = await invoke(overseerr_get_request, { id: 12 });

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/api/v1/request/12',
      '/api/v1/tv/95396',
    ]);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      title: 'Severance',
      year: '2022',
    });
  });

  it('approves a request by id', async () => {
    const { calls } = installFetchMock([
      authRoute,
      route('POST', '/api/v1/request/12/approve', { json: { id: 12, status: 2 } }),
    ]);

    await invoke(overseerr_approve_request, { id: 12 });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/v1/auth/me',
      'POST /api/v1/request/12/approve',
    ]);
  });

  it('does not approve the same request twice within the idempotency ttl', async () => {
    const { calls } = installFetchMock([
      authRoute,
      route('POST', '/api/v1/request/12/approve', { json: { id: 12, status: 2 } }),
    ]);

    await invoke(overseerr_approve_request, { id: 12 });
    const duplicate = await invoke(overseerr_approve_request, { id: 12 });

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(JSON.parse((duplicate.content[0] as { text: string }).text)).toMatchObject({
      idempotent: true,
      duplicate: true,
      key: 'overseerr_approve_request:12',
    });
  });

  it('rejects a request by id via the Overseerr decline endpoint', async () => {
    const { calls } = installFetchMock([
      authRoute,
      route('POST', '/api/v1/request/12/decline', { json: { id: 12, status: 3 } }),
    ]);

    await invoke(overseerr_reject_request, { id: 12 });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/v1/auth/me',
      'POST /api/v1/request/12/decline',
    ]);
  });

  it('does not reject the same request twice within the idempotency ttl', async () => {
    const { calls } = installFetchMock([
      authRoute,
      route('POST', '/api/v1/request/12/decline', { json: { id: 12, status: 3 } }),
    ]);

    await invoke(overseerr_reject_request, { id: 12 });
    const duplicate = await invoke(overseerr_reject_request, { id: 12 });

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(JSON.parse((duplicate.content[0] as { text: string }).text)).toMatchObject({
      idempotent: true,
      duplicate: true,
      key: 'overseerr_reject_request:12',
    });
  });

  it('deletes a request by id and does not repeat duplicate deletes', async () => {
    const { calls } = installFetchMock([
      authRoute,
      route('DELETE', '/api/v1/request/12', { json: { id: 12, deleted: true } }),
    ]);

    await invoke(overseerr_delete_request, { id: 12 });
    const duplicate = await invoke(overseerr_delete_request, { id: 12 });

    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(JSON.parse((duplicate.content[0] as { text: string }).text)).toMatchObject({
      idempotent: true,
      duplicate: true,
      status: 'completed',
      key: 'overseerr_delete_request:12',
    });
  });

  it('shares duplicate protection between legacy cancel and delete request tools', async () => {
    const { calls } = installFetchMock([
      authRoute,
      route('DELETE', '/api/v1/request/12', { json: { id: 12, deleted: true } }),
    ]);

    await invoke(overseerr_cancel_request, { id: 12 });
    const duplicate = await invoke(overseerr_delete_request, { id: 12 });

    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(JSON.parse((duplicate.content[0] as { text: string }).text)).toMatchObject({
      idempotent: true,
      duplicate: true,
      key: 'overseerr_delete_request:12',
    });
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

describe('overseerr_discover', () => {
  it('maps genre names to discover filters and returns library status', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/discover/movies', {
        json: {
          results: [
            {
              id: 348,
              mediaType: 'movie',
              title: 'Alien',
              releaseDate: '1979-05-25',
              mediaInfo: { status: 5 },
            },
            {
              id: 111,
              mediaType: 'movie',
              title: 'Missing Horror',
              releaseDate: '2024-10-01',
            },
          ],
        },
      }),
    ]);

    const result = await invoke(overseerr_discover, { genre: 'horror' });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/discover/movies');
    expect(url.searchParams.get('genre')).toBe('27');

    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.summary).toMatch(/2 movie horror titles/);
    expect(parsed.items[0]).toMatchObject({
      tmdbId: 348,
      title: 'Alien',
      libraryStatus: 'available',
    });
    expect(parsed.items[1].libraryStatus).toBe('missing');
  });

  it('supports sci-fi aliases for TV discover', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/discover/tv', { json: { results: [] } }),
    ]);

    await invoke(overseerr_discover, { mediaType: 'tv', genre: 'sci fi' });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/discover/tv');
    expect(url.searchParams.get('genre')).toBe('10765');
  });
});

describe('overseerr_discover_hidden_gems', () => {
  it('sorts by vote_average.desc and filters by rating + vote-count window', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/discover/movies', {
        json: {
          results: [
            // Below minVoteAverage
            { id: 1, mediaType: 'movie', title: 'Meh', voteAverage: 6.5, voteCount: 800 },
            // Too few votes
            { id: 2, mediaType: 'movie', title: 'Obscure', voteAverage: 9.0, voteCount: 50 },
            // Too widely known
            { id: 3, mediaType: 'movie', title: 'Mega Hit', voteAverage: 8.2, voteCount: 20000 },
            // Passes everything; missing from library
            { id: 4, mediaType: 'movie', title: 'Gem', releaseDate: '2014-01-01', voteAverage: 8.1, voteCount: 1500 },
            // Passes filters but already in library — should be excluded by default
            {
              id: 5,
              mediaType: 'movie',
              title: 'Already Owned',
              voteAverage: 7.9,
              voteCount: 1200,
              mediaInfo: { status: 5 },
            },
          ],
          totalPages: 1,
        },
      }),
    ]);

    const result = await invoke(overseerr_discover_hidden_gems, { mediaType: 'movie' });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/discover/movies');
    expect(url.searchParams.get('sortBy')).toBe('vote_average.desc');

    expect(parsed.summary).toMatch(/1 movie hidden gem \(rating ≥ 7.5, votes 200-5000\)/);
    expect(parsed.items).toEqual([
      {
        tmdbId: 4,
        mediaType: 'movie',
        title: 'Gem',
        year: '2014',
        voteAverage: 8.1,
        voteCount: 1500,
        libraryStatus: 'missing',
      },
    ]);
  });

  it('pages through multiple results pages until the limit is hit', async () => {
    const { calls } = installFetchMock([
      routeSequence('GET', '/api/v1/discover/movies', [
        // Page 1: only one item passes the vote-count window.
        {
          json: {
            results: [
              { id: 1, mediaType: 'movie', title: 'Mega', voteAverage: 8.5, voteCount: 50000 },
              { id: 2, mediaType: 'movie', title: 'Pass A', voteAverage: 8.0, voteCount: 1000 },
            ],
            totalPages: 3,
          },
        },
        // Page 2: two more that pass, so the tool stops with 2 in hand.
        {
          json: {
            results: [
              { id: 3, mediaType: 'movie', title: 'Pass B', voteAverage: 7.9, voteCount: 900 },
              { id: 4, mediaType: 'movie', title: 'Pass C', voteAverage: 7.8, voteCount: 800 },
            ],
            totalPages: 3,
          },
        },
      ]),
    ]);

    const result = await invoke(overseerr_discover_hidden_gems, { take: 2 });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    const discoverCalls = calls.filter((c) => c.url.includes('/api/v1/discover/movies'));
    expect(discoverCalls).toHaveLength(2);
    expect(new URL(discoverCalls[0].url).searchParams.get('page')).toBe('1');
    expect(new URL(discoverCalls[1].url).searchParams.get('page')).toBe('2');
    expect(parsed.items.map((i: { tmdbId: number }) => i.tmdbId)).toEqual([2, 3]);
  });

  it('includes library items when includeInLibrary is true', async () => {
    installFetchMock([
      route('GET', '/api/v1/discover/movies', {
        json: {
          results: [
            {
              id: 9,
              mediaType: 'movie',
              title: 'Owned Gem',
              voteAverage: 8.0,
              voteCount: 1000,
              mediaInfo: { status: 5 },
            },
          ],
          totalPages: 1,
        },
      }),
    ]);

    const result = await invoke(overseerr_discover_hidden_gems, { includeInLibrary: true });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.items).toEqual([
      expect.objectContaining({ tmdbId: 9, libraryStatus: 'available' }),
    ]);
  });

  it('errors when minVoteCount > maxVoteCount', async () => {
    installFetchMock([]);

    const result = await invoke(overseerr_discover_hidden_gems, {
      minVoteCount: 5000,
      maxVoteCount: 100,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as { error: string };
    expect(parsed.error).toMatch(/minVoteCount \(5000\) must be ≤ maxVoteCount \(100\)/);
  });
});
