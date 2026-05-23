import { describe, expect, it } from 'vitest';
import { installFetchMock, invoke, route } from './_testing.js';
import { mdblist_ratings } from './mdblist.js';

describe('mdblist_ratings', () => {
  it('groups by media type, matches via ids.tmdb (not the internal id), and merges streaming providers', async () => {
    const { calls } = installFetchMock([
      route('POST', 'api.mdblist.com/tmdb/movie', {
        json: [
          {
            // MDBList's internal id — must NOT be used for matching.
            id: 469990,
            ids: { tmdb: 603, imdb: 'tt0133093' },
            title: 'The Matrix',
            year: 1999,
            ratings: [
              { source: 'imdb', value: 8.7, votes: 2000000 },
              { source: 'tomatoes', value: 83 },
            ],
            streams: [{ id: 8, name: 'HBO MAX' }],
            watch_providers: [
              { id: 1899, name: 'HBO Max' }, // dedupes against the streams entry above (case-insensitive)
              { id: 2528, name: 'YouTube TV' },
            ],
          },
          // tmdbId 11159 deliberately omitted to exercise the "missing" path
        ],
      }),
      route('POST', 'api.mdblist.com/tmdb/show', {
        json: [
          {
            id: 999111,
            ids: { tmdb: 95396, imdb: 'tt11280740' },
            title: 'Severance',
            year: 2022,
            ratings: [{ source: 'imdb', value: 8.7 }],
            streams: [],
            watch_providers: [{ id: 1, name: 'Apple TV+' }],
          },
        ],
      }),
    ]);

    const result = await invoke(mdblist_ratings, {
      items: [
        { tmdbId: 603, mediaType: 'movie' },
        { tmdbId: 11159, mediaType: 'movie' },
        { tmdbId: 95396, mediaType: 'series' },
      ],
    });

    expect(calls).toHaveLength(2);
    const movieCall = calls.find((c) => c.url.includes('/tmdb/movie/'))!;
    const showCall = calls.find((c) => c.url.includes('/tmdb/show/'))!;
    expect(movieCall.method).toBe('POST');
    expect(movieCall.body).toEqual({ ids: [603, 11159] });
    expect(showCall.body).toEqual({ ids: [95396] });

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.summary).toContain('2 titles');
    expect(payload.summary).toContain('1 missing');
    expect(payload.summary).toContain('2 requests');
    expect(payload.items).toEqual([
      {
        tmdbId: 603,
        mediaType: 'movie',
        title: 'The Matrix',
        year: 1999,
        imdbId: 'tt0133093',
        ratings: [
          { source: 'IMDb', score: 8.7, votes: 2000000 },
          { source: 'Rotten Tomatoes (critics)', score: 83 },
        ],
        streamingProviders: ['HBO MAX', 'YouTube TV'],
      },
      {
        tmdbId: 95396,
        mediaType: 'tv',
        title: 'Severance',
        year: 2022,
        imdbId: 'tt11280740',
        ratings: [{ source: 'IMDb', score: 8.7 }],
        streamingProviders: ['Apple TV+'],
      },
    ]);
    expect(payload.missing).toEqual([{ tmdbId: 11159, mediaType: 'movie' }]);
  });

  it('omits streamingProviders when the response has no providers', async () => {
    installFetchMock([
      route('POST', 'api.mdblist.com/tmdb/movie', {
        json: [
          {
            id: 1,
            ids: { tmdb: 603 },
            title: 'The Matrix',
            year: 1999,
            ratings: [{ source: 'imdb', value: 8.7 }],
            streams: [],
            watch_providers: [],
          },
        ],
      }),
    ]);

    const result = await invoke(mdblist_ratings, {
      items: [{ tmdbId: 603, mediaType: 'movie' }],
    });

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.items[0]).not.toHaveProperty('streamingProviders');
  });

  it('skips the call for a media type with no items', async () => {
    const { calls } = installFetchMock([
      route('POST', 'api.mdblist.com/tmdb/show', {
        json: [
          { id: 1, ids: { tmdb: 95396 }, title: 'Severance', year: 2022, ratings: [] },
        ],
      }),
    ]);

    await invoke(mdblist_ratings, {
      items: [{ tmdbId: 95396, mediaType: 'tv' }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/tmdb/show/');
  });

  it('accepts mediaType aliases like "series" and "film"', async () => {
    const { calls } = installFetchMock([
      route('POST', 'api.mdblist.com/tmdb/movie', {
        json: [{ id: 1, ids: { tmdb: 603 }, title: 'The Matrix', year: 1999, ratings: [] }],
      }),
      route('POST', 'api.mdblist.com/tmdb/show', {
        json: [{ id: 2, ids: { tmdb: 95396 }, title: 'Severance', year: 2022, ratings: [] }],
      }),
    ]);

    await invoke(mdblist_ratings, {
      items: [
        { tmdbId: 603, mediaType: 'film' },
        { tmdbId: 95396, mediaType: 'series' },
      ],
    });

    expect(calls.find((c) => c.url.includes('/tmdb/movie/'))!.body).toEqual({ ids: [603] });
    expect(calls.find((c) => c.url.includes('/tmdb/show/'))!.body).toEqual({ ids: [95396] });
  });
});
