import { describe, expect, it } from 'vitest';
import { installFetchMock, invoke, route } from './_testing.js';
import { mdblist_list, mdblist_ratings } from './mdblist.js';

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

describe('mdblist_list', () => {
  const listResponse = {
    movies: [
      {
        id: 603,
        mediatype: 'movie',
        imdb_id: 'tt0133093',
        ids: { tmdb: 603, imdb: 'tt0133093', tvdb: 12345 },
        title: 'The Matrix',
        release_year: 1999,
        release_date: '1999-03-31',
        runtime: 136,
        rank: 1,
      },
    ],
    shows: [
      {
        id: 95396,
        mediatype: 'show',
        imdb_id: 'tt11280740',
        ids: { tmdb: 95396, imdb: 'tt11280740' },
        title: 'Severance',
        release_year: 2022,
        release_date: '2022-02-18',
        rank: 2,
      },
    ],
    pagination: { limit: 1000, offset: 0, total: 2, has_more: false },
  };

  it('parses a full mdblist.com URL and returns items with normalized ids', async () => {
    const { calls } = installFetchMock([
      route('GET', 'api.mdblist.com/lists/hdlists/horror-top/items', { json: listResponse }),
    ]);

    const result = await invoke(mdblist_list, {
      list: 'https://mdblist.com/lists/hdlists/horror-top',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/lists/hdlists/horror-top/items');
    expect(calls[0].url).toContain('apikey=');

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.summary).toContain('hdlists/horror-top');
    expect(payload.summary).toContain('2 items');
    expect(payload.list).toEqual({ user: 'hdlists', slug: 'horror-top' });
    expect(payload.pagination).toEqual({ limit: 1000, offset: 0, total: 2, hasMore: false });
    expect(payload.items).toEqual([
      {
        title: 'The Matrix',
        year: 1999,
        mediaType: 'movie',
        imdbId: 'tt0133093',
        tmdbId: 603,
        tvdbId: 12345,
        releaseDate: '1999-03-31',
        runtime: 136,
        rank: 1,
      },
      {
        title: 'Severance',
        year: 2022,
        mediaType: 'tv',
        imdbId: 'tt11280740',
        tmdbId: 95396,
        tvdbId: null,
        releaseDate: '2022-02-18',
        runtime: null,
        rank: 2,
      },
    ]);
  });

  it('accepts the "user/slug" shorthand', async () => {
    const { calls } = installFetchMock([
      route('GET', 'api.mdblist.com/lists/hdlists/horror-top/items', { json: listResponse }),
    ]);

    await invoke(mdblist_list, { list: 'hdlists/horror-top' });

    expect(calls[0].url).toContain('/lists/hdlists/horror-top/items');
  });

  it('filters by mediaType', async () => {
    installFetchMock([
      route('GET', 'api.mdblist.com/lists/hdlists/horror-top/items', { json: listResponse }),
    ]);

    const moviesOnly = await invoke(mdblist_list, {
      list: 'hdlists/horror-top',
      mediaType: 'movie',
    });
    const moviesPayload = JSON.parse((moviesOnly.content[0] as { text: string }).text);
    expect(moviesPayload.items.map((i: { title: string }) => i.title)).toEqual(['The Matrix']);

    const showsOnly = await invoke(mdblist_list, {
      list: 'hdlists/horror-top',
      mediaType: 'series',
    });
    const showsPayload = JSON.parse((showsOnly.content[0] as { text: string }).text);
    expect(showsPayload.items.map((i: { title: string }) => i.title)).toEqual(['Severance']);
  });

  it('passes limit and offset through to the API', async () => {
    const { calls } = installFetchMock([
      route('GET', 'api.mdblist.com/lists/hdlists/horror-top/items', { json: listResponse }),
    ]);

    await invoke(mdblist_list, { list: 'hdlists/horror-top', limit: 50, offset: 100 });

    expect(calls[0].url).toContain('limit=50');
    expect(calls[0].url).toContain('offset=100');
  });

  it('returns isError when the list reference cannot be parsed', async () => {
    installFetchMock([]);
    const result = await invoke(mdblist_list, { list: 'not-a-valid-ref' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.error).toContain('Could not parse list reference');
  });

  it('returns isError on API failures instead of throwing', async () => {
    installFetchMock([
      route('GET', 'api.mdblist.com/lists/hdlists/missing/items', {
        status: 404,
        text: '{"error":"not found"}',
      }),
    ]);

    const result = await invoke(mdblist_list, { list: 'hdlists/missing' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.error).toContain('404');
  });

  describe('with ratingsFilter', () => {
    const filterListResponse = {
      movies: [
        { id: 1, mediatype: 'movie', ids: { tmdb: 1 }, title: 'High IMDb only', release_year: 2024, rank: 1 },
        { id: 2, mediatype: 'movie', ids: { tmdb: 2 }, title: 'High RT only', release_year: 2024, rank: 2 },
        { id: 3, mediatype: 'movie', ids: { tmdb: 3 }, title: 'Both high', release_year: 2024, rank: 3 },
        { id: 4, mediatype: 'movie', ids: { tmdb: 4 }, title: 'Both low', release_year: 2024, rank: 4 },
        { id: 5, mediatype: 'movie', ids: { tmdb: 5 }, title: 'No ratings at all', release_year: 2024, rank: 5 },
      ],
      shows: [],
      pagination: { limit: 1000, offset: 0, total: 5, has_more: false },
    };

    const ratingsBatch = [
      { id: 1, ids: { tmdb: 1 }, ratings: [{ source: 'imdb', value: 8.0 }, { source: 'tomatoes', value: 40 }] },
      { id: 2, ids: { tmdb: 2 }, ratings: [{ source: 'imdb', value: 5.0 }, { source: 'tomatoes', value: 80 }] },
      { id: 3, ids: { tmdb: 3 }, ratings: [{ source: 'imdb', value: 8.5 }, { source: 'tomatoes', value: 90 }] },
      { id: 4, ids: { tmdb: 4 }, ratings: [{ source: 'imdb', value: 4.0 }, { source: 'tomatoes', value: 30 }] },
      { id: 5, ids: { tmdb: 5 }, ratings: [] },
    ];

    it('"any" combinator passes when any single threshold is met, and surfaces scores inline', async () => {
      const { calls } = installFetchMock([
        route('GET', 'api.mdblist.com/lists/hdlists/horror-top/items', { json: filterListResponse }),
        route('POST', 'api.mdblist.com/tmdb/movie', { json: ratingsBatch }),
      ]);

      const result = await invoke(mdblist_list, {
        list: 'hdlists/horror-top',
        ratingsFilter: { minImdb: 7, minTomatoes: 65 },
      });

      // Ratings batch should have been requested for every tmdbId in the list.
      const ratingsCall = calls.find((c) => c.url.includes('/tmdb/movie/'));
      expect(ratingsCall?.body).toEqual({ ids: [1, 2, 3, 4, 5] });

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.summary).toContain('3/5 items pass');
      expect(payload.summary).toContain('combinator: any');
      expect(payload.items.map((i: { title: string }) => i.title)).toEqual([
        'High IMDb only',
        'High RT only',
        'Both high',
      ]);
      expect(payload.items[0]).toMatchObject({ ratings: { imdb: 8.0, tomatoes: 40 } });
      expect(payload.filter).toMatchObject({ input: 5, passed: 3, minImdb: 7, minTomatoes: 65 });
    });

    it('"all" combinator requires every set threshold to be met', async () => {
      installFetchMock([
        route('GET', 'api.mdblist.com/lists/hdlists/horror-top/items', { json: filterListResponse }),
        route('POST', 'api.mdblist.com/tmdb/movie', { json: ratingsBatch }),
      ]);

      const result = await invoke(mdblist_list, {
        list: 'hdlists/horror-top',
        ratingsFilter: { combinator: 'all', minImdb: 7, minTomatoes: 65 },
      });

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.items.map((i: { title: string }) => i.title)).toEqual(['Both high']);
    });

    it('missing scores never pass — items with no ratings are dropped', async () => {
      installFetchMock([
        route('GET', 'api.mdblist.com/lists/hdlists/horror-top/items', { json: filterListResponse }),
        route('POST', 'api.mdblist.com/tmdb/movie', { json: ratingsBatch }),
      ]);

      // Threshold on RT audience, which no item has — should match zero.
      const result = await invoke(mdblist_list, {
        list: 'hdlists/horror-top',
        ratingsFilter: { minTomatoesAudience: 65 },
      });

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.items).toEqual([]);
      expect(payload.summary).toContain('0/5 items pass');
    });

    it('groups movies and tv into separate batched ratings calls', async () => {
      const mixedList = {
        movies: [{ id: 1, mediatype: 'movie', ids: { tmdb: 1 }, title: 'M', release_year: 2024 }],
        shows: [{ id: 100, mediatype: 'show', ids: { tmdb: 100 }, title: 'S', release_year: 2024 }],
        pagination: { limit: 1000, offset: 0, total: 2, has_more: false },
      };
      const { calls } = installFetchMock([
        route('GET', 'api.mdblist.com/lists/hdlists/mixed/items', { json: mixedList }),
        route('POST', 'api.mdblist.com/tmdb/movie', {
          json: [{ id: 1, ids: { tmdb: 1 }, ratings: [{ source: 'imdb', value: 9.0 }] }],
        }),
        route('POST', 'api.mdblist.com/tmdb/show', {
          json: [{ id: 100, ids: { tmdb: 100 }, ratings: [{ source: 'imdb', value: 9.0 }] }],
        }),
      ]);

      await invoke(mdblist_list, {
        list: 'hdlists/mixed',
        ratingsFilter: { minImdb: 7 },
      });

      expect(calls.find((c) => c.url.includes('/tmdb/movie/'))!.body).toEqual({ ids: [1] });
      expect(calls.find((c) => c.url.includes('/tmdb/show/'))!.body).toEqual({ ids: [100] });
    });
  });
});
