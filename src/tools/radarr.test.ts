import { describe, expect, it, beforeEach } from 'vitest';
import { radarr_replace_movie } from './radarr.js';
import { installFetchMock, invoke, route } from './_testing.js';

function radarrMovie(opts: { hasFile?: boolean } = {}) {
  return [
    {
      id: 42,
      title: 'The Matrix',
      year: 1999,
      tmdbId: 603,
      hasFile: opts.hasFile ?? true,
      movieFile: opts.hasFile === false
        ? undefined
        : {
            id: 7,
            relativePath: 'The Matrix (1999)/Matrix.mkv',
            size: 12_400_000_000,
            quality: { quality: { name: 'Bluray-1080p' } },
          },
    },
  ];
}

describe('radarr_replace_movie', () => {
  beforeEach(() => {
    // Each test installs its own mock.
  });

  it('deletes the existing file BEFORE triggering the search command', async () => {
    const { calls } = installFetchMock([
      route('GET', '/movie?tmdbId=603', { json: radarrMovie() }),
      route('DELETE', '/moviefile/7', { json: {} }),
      route('POST', '/command', { json: { id: 99, name: 'MoviesSearch', status: 'queued' } }),
    ]);

    await invoke(radarr_replace_movie, { tmdbId: 603 });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`))
      .toEqual([
        'GET /api/v3/movie?tmdbId=603',
        'DELETE /api/v3/moviefile/7',
        'POST /api/v3/command',
      ]);
    expect(calls[2].body).toEqual({ name: 'MoviesSearch', movieIds: [42] });
  });

  it('skips the DELETE when keepFile=true and still triggers search', async () => {
    const { calls } = installFetchMock([
      route('GET', '/movie?tmdbId=603', { json: radarrMovie() }),
      route('POST', '/command', { json: { id: 99, name: 'MoviesSearch', status: 'queued' } }),
    ]);

    await invoke(radarr_replace_movie, { tmdbId: 603, keepFile: true });

    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('skips the DELETE when the movie has no file currently', async () => {
    const { calls } = installFetchMock([
      route('GET', '/movie?tmdbId=603', { json: radarrMovie({ hasFile: false }) }),
      route('POST', '/command', { json: { id: 99, name: 'MoviesSearch', status: 'queued' } }),
    ]);

    await invoke(radarr_replace_movie, { tmdbId: 603 });

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'MoviesSearch',
      movieIds: [42],
    });
  });

  it('returns isError:true when the movie is not in Radarr (not throwing)', async () => {
    installFetchMock([route('GET', '/movie?tmdbId=999999', { json: [] })]);

    const result = await invoke(radarr_replace_movie, { tmdbId: 999999 });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text).error).toMatch(/No Radarr movie/);
  });

  it('returns isError:true when the API returns 500', async () => {
    installFetchMock([
      route('GET', '/movie?tmdbId=603', { status: 500, text: 'internal error' }),
    ]);

    const result = await invoke(radarr_replace_movie, { tmdbId: 603 });

    expect(result.isError).toBe(true);
  });
});
