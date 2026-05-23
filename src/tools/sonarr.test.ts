import { beforeEach, describe, expect, it } from 'vitest';
import { sonarr_replace } from './sonarr.js';
import { installFetchMock, invoke, route } from './_testing.js';
import { resetIdempotencyForTests } from './idempotency.js';

function tvDetail() {
  return { externalIds: { tvdbId: 1234 } };
}

function sonarrSeries() {
  return [{ id: 11, title: 'Severance', tvdbId: 1234 }];
}

function sonarrEpisodes() {
  return [
    { id: 101, seriesId: 11, seasonNumber: 1, episodeNumber: 1, episodeFileId: 501, hasFile: true, title: 'Good News About Hell' },
    { id: 102, seriesId: 11, seasonNumber: 1, episodeNumber: 2, episodeFileId: 502, hasFile: true, title: 'Half Loop' },
    { id: 103, seriesId: 11, seasonNumber: 1, episodeNumber: 3, episodeFileId: 0, hasFile: false, title: 'In Perpetuity' },
  ];
}

beforeEach(() => {
  resetIdempotencyForTests();
});

describe('sonarr_replace (single episode)', () => {
  it('deletes the single episode file BEFORE triggering EpisodeSearch', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: sonarrEpisodes() }),
      route('DELETE', '/episodefile/502', { json: {} }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
    ]);

    await invoke(sonarr_replace, { tmdbId: 603, seasonNumber: 1, episodeNumber: 2 });

    const sequence = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    const deleteIdx = sequence.findIndex((s) => s.startsWith('DELETE'));
    const postIdx = sequence.findIndex((s) => s.startsWith('POST'));
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(deleteIdx);

    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'EpisodeSearch',
      episodeIds: [102],
    });
  });

  it('only deletes the targeted episode\'s file, not others', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: sonarrEpisodes() }),
      route('DELETE', '/episodefile/502', { json: {} }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
    ]);

    await invoke(sonarr_replace, { tmdbId: 603, seasonNumber: 1, episodeNumber: 2 });

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toMatch(/episodefile\/502/);
  });

  it('does not delete or trigger search twice for duplicate same-arg calls', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: sonarrEpisodes() }),
      route('DELETE', '/episodefile/502', { json: {} }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
    ]);

    await invoke(sonarr_replace, { tmdbId: 603, seasonNumber: 1, episodeNumber: 2 });
    const duplicate = await invoke(sonarr_replace, { tmdbId: 603, seasonNumber: 1, episodeNumber: 2 });

    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(JSON.parse((duplicate.content[0] as { text: string }).text)).toMatchObject({
      idempotent: true,
      duplicate: true,
      status: 'completed',
      key: 'sonarr_replace:603:1:2:false',
    });
  });
});

describe('sonarr_replace (full season)', () => {
  it('deletes every episode-with-file in the season, then triggers SeasonSearch', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: sonarrEpisodes() }),
      route('DELETE', '/episodefile/501', { json: {} }),
      route('DELETE', '/episodefile/502', { json: {} }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
    ]);

    await invoke(sonarr_replace, { tmdbId: 603, seasonNumber: 1 });

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((d) => new URL(d.url).pathname)).toEqual([
      '/api/v3/episodefile/501',
      '/api/v3/episodefile/502',
    ]);

    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'SeasonSearch',
      seriesId: 11,
      seasonNumber: 1,
    });
  });
});

describe('sonarr_replace (keepFile)', () => {
  it('skips all DELETEs and still triggers the search command', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: sonarrEpisodes() }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
    ]);

    await invoke(sonarr_replace, {
      tmdbId: 603,
      seasonNumber: 1,
      episodeNumber: 1,
      keepFile: true,
    });

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'EpisodeSearch',
      episodeIds: [101],
    });
  });
});

describe('sonarr_replace (error paths)', () => {
  it('returns isError when Overseerr has no TVDB mapping', async () => {
    installFetchMock([route('GET', '/api/v1/tv/603', { json: { externalIds: {} } })]);

    const result = await invoke(sonarr_replace, { tmdbId: 603, seasonNumber: 1 });

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text).error).toMatch(/TVDB/);
  });

  it('returns isError when the episode does not exist', async () => {
    installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: [] }),
    ]);

    const result = await invoke(sonarr_replace, {
      tmdbId: 603,
      seasonNumber: 5,
      episodeNumber: 1,
    });

    expect(result.isError).toBe(true);
  });
});
