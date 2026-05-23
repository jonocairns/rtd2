import { describe, expect, it } from 'vitest';
import { plex_apply_match, plex_search, plex_unwatched } from './plex.js';
import { installFetchMock, invoke, route } from './_testing.js';

describe('plex_apply_match', () => {
  it('sends a PUT to /library/metadata/{key}/match with guid + name in the querystring', async () => {
    const { calls } = installFetchMock([
      route('PUT', '/library/metadata/55555/match', { status: 200, json: {} }),
    ]);

    const result = await invoke(plex_apply_match, {
      ratingKey: '55555',
      guid: 'tmdb://603',
      name: 'The Matrix (1999)',
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/library/metadata/55555/match');
    expect(url.searchParams.get('guid')).toBe('tmdb://603');
    expect(url.searchParams.get('name')).toBe('The Matrix (1999)');

    // Tool should report what it applied.
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      ratingKey: '55555',
      applied: { guid: 'tmdb://603', name: 'The Matrix (1999)' },
    });
  });

  it('omits the name parameter when not provided', async () => {
    const { calls } = installFetchMock([
      route('PUT', '/library/metadata/55555/match', { status: 200, json: {} }),
    ]);

    await invoke(plex_apply_match, { ratingKey: '55555', guid: 'tmdb://603' });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('guid')).toBe('tmdb://603');
    expect(url.searchParams.has('name')).toBe(false);
  });
});

describe('plex_search', () => {
  it('flattens results across Hub buckets and applies the envelope', async () => {
    installFetchMock([
      route('GET', '/search', {
        json: {
          MediaContainer: {
            Hub: [
              {
                type: 'movie',
                Metadata: [
                  { ratingKey: '1', title: 'The Matrix', type: 'movie', year: 1999, guid: 'plex://movie/abc' },
                ],
              },
              {
                type: 'show',
                Metadata: [
                  { ratingKey: '2', title: 'Severance', type: 'show', year: 2022, guid: 'plex://show/def' },
                ],
              },
            ],
          },
        },
      }),
    ]);

    const result = await invoke(plex_search, { query: 'matrix' });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.summary).toMatch(/2 Plex items matching "matrix"/);
    expect(parsed.items).toEqual([
      { ratingKey: '1', title: 'The Matrix', type: 'movie', year: 1999, guid: 'plex://movie/abc' },
      { ratingKey: '2', title: 'Severance', type: 'show', year: 2022, guid: 'plex://show/def' },
    ]);
  });
});

describe('plex_unwatched', () => {
  it('queries each matching section and merges results', async () => {
    const { calls } = installFetchMock([
      // Most specific first — installFetchMock uses Array.find() and would
      // otherwise route /library/sections/1/unwatched to the sections list.
      route('GET', '/library/sections/1/unwatched', {
        json: {
          MediaContainer: {
            Metadata: [{ title: 'Dune', type: 'movie', year: 2021, addedAt: 1700000000 }],
          },
        },
      }),
      route('GET', '/library/sections', {
        json: {
          MediaContainer: {
            Directory: [
              { key: '1', type: 'movie', title: 'Movies' },
              { key: '2', type: 'show', title: 'TV Shows' },
            ],
          },
        },
      }),
    ]);

    const result = await invoke(plex_unwatched, { section: 'movies' });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.summary).toMatch(/1 unwatched item \(movies/);
    expect(parsed.items[0].title).toBe('Dune');

    // Only the movie section should have been queried.
    expect(calls.filter((c) => c.url.includes('/unwatched'))).toHaveLength(1);
  });
});
