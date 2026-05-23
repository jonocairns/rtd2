import { describe, expect, it } from 'vitest';
import { installFetchMock, invoke, route } from './_testing.js';
import { mdblist_ratings } from './mdblist.js';

describe('mdblist_ratings', () => {
  it('accepts series as a mediaType alias for tv', async () => {
    const { calls } = installFetchMock([
      route('GET', 'mdblist.com/api', {
        json: {
          title: 'Severance',
          year: 2022,
          imdbid: 'tt11280740',
          ratings: [{ source: 'imdb', value: 8.7, votes: 250000 }],
        },
      }),
    ]);

    const result = await invoke(mdblist_ratings, { tmdbId: 95396, mediaType: 'series' });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('tm')).toBe('95396');
    expect(url.searchParams.get('m')).toBe('show');
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      title: 'Severance',
      ratings: [{ source: 'IMDb', score: 8.7, votes: 250000 }],
    });
  });

  it('accepts film as a mediaType alias for movie', async () => {
    const { calls } = installFetchMock([
      route('GET', 'mdblist.com/api', {
        json: {
          title: 'The Matrix',
          year: 1999,
          imdbid: 'tt0133093',
          ratings: [{ source: 'tomatoes', value: 83 }],
        },
      }),
    ]);

    await invoke(mdblist_ratings, { tmdbId: 603, mediaType: 'film' });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('tm')).toBe('603');
    expect(url.searchParams.get('m')).toBe('movie');
  });
});
