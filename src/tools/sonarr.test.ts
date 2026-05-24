import { beforeEach, describe, expect, it } from 'vitest';
import {
  guardReplace,
  sonarr_episode_replacement_candidates,
  sonarr_file_quality_check,
  sonarr_replace,
} from './sonarr.js';
import { installFetchMock, invoke, route, routeSequence } from './_testing.js';
import { resetIdempotencyForTests } from './idempotency.js';

function tvDetail() {
  return { externalIds: { tvdbId: 1234 } };
}

function sonarrSeries() {
  return [{ id: 11, title: 'Severance', tvdbId: 1234 }];
}

function sonarrEpisodes() {
  return [
    {
      id: 101,
      seriesId: 11,
      seasonNumber: 1,
      episodeNumber: 1,
      episodeFileId: 501,
      hasFile: true,
      title: 'Good News About Hell',
      episodeFile: {
        quality: { quality: { name: 'WEB-1080p' } },
        size: 2.2 * 1024 ** 3,
        relativePath: 'Severance/Season 1/S01E01.mkv',
      },
    },
    {
      id: 102,
      seriesId: 11,
      seasonNumber: 1,
      episodeNumber: 2,
      episodeFileId: 502,
      hasFile: true,
      title: 'Half Loop',
      episodeFile: {
        quality: { quality: { name: 'WEB-1080p' } },
        size: 2.1 * 1024 ** 3,
        relativePath: 'Severance/Season 1/S01E02.mkv',
      },
    },
    { id: 103, seriesId: 11, seasonNumber: 1, episodeNumber: 3, episodeFileId: 0, hasFile: false, title: 'In Perpetuity' },
  ];
}

function sonarrEpisodesAfterDelete(fileIds: number[]) {
  const deleted = new Set(fileIds);
  return sonarrEpisodes().map((episode) =>
    deleted.has(episode.episodeFileId)
      ? { ...episode, episodeFileId: 0, hasFile: false }
      : episode
  );
}

function mixedQualityEpisodes() {
  return [
    sonarrEpisodes()[0],
    {
      ...sonarrEpisodes()[1],
      episodeFile: {
        quality: { quality: { name: 'SDTV' } },
        size: 460 * 1024 ** 2,
        relativePath: 'Severance/Season 1/S01E02.avi',
      },
    },
    sonarrEpisodes()[2],
  ];
}

function goodRelease() {
  return {
    guid: 'good-guid',
    indexerId: 7,
    title: 'Severance.S01E02.1080p.WEB.h264-GROUP',
    indexer: 'NZBgeek',
    size: 2.4 * 1024 ** 3,
    age: 10,
    quality: { quality: { name: 'WEB-1080p' } },
    customFormatScore: 100,
    rejected: false,
    rejections: [],
  };
}

function sdRelease() {
  return {
    guid: 'sd-guid',
    indexerId: 7,
    title: 'Severance.S01E02.SDTV.XviD-GROUP',
    indexer: 'NZBgeek',
    size: 450 * 1024 ** 2,
    age: 400,
    quality: { quality: { name: 'SDTV' } },
    customFormatScore: 20_000,
    rejected: false,
    rejections: [],
  };
}

function rejectedGoodRelease() {
  return {
    ...goodRelease(),
    guid: 'rejected-good-guid',
    rejected: true,
    rejections: ['Quality profile does not allow WEB-1080p'],
  };
}

beforeEach(() => {
  resetIdempotencyForTests();
});

describe('sonarr_replace (single episode)', () => {
  it('deletes the single episode file BEFORE triggering EpisodeSearch', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      routeSequence('GET', '/episode?seriesId=11', [
        { json: sonarrEpisodes() },
        { json: sonarrEpisodesAfterDelete([502]) },
      ]),
      route('GET', '/release?episodeId=102', { json: [goodRelease()] }),
      route('DELETE', '/episodefile/502', { json: {} }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 50, name: 'EpisodeSearch', status: 'queued' }] }),
    ]);

    const result = await invoke(sonarr_replace, { tmdbId: 603, seasonNumber: 1, episodeNumber: 2 });

    const sequence = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    const deleteIdx = sequence.findIndex((s) => s.startsWith('DELETE'));
    const postIdx = sequence.findIndex((s) => s.startsWith('POST'));
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(deleteIdx);

    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'EpisodeSearch',
      episodeIds: [102],
    });
    expect(JSON.parse((result.content[0] as { text: string }).text).selfCheck).toMatchObject({
      ok: true,
      fileStateOk: true,
      searchCommandVisible: true,
    });
  });

  it('only deletes the targeted episode\'s file, not others', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      routeSequence('GET', '/episode?seriesId=11', [
        { json: sonarrEpisodes() },
        { json: sonarrEpisodesAfterDelete([502]) },
      ]),
      route('GET', '/release?episodeId=102', { json: [goodRelease()] }),
      route('DELETE', '/episodefile/502', { json: {} }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 50, name: 'EpisodeSearch', status: 'queued' }] }),
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
      routeSequence('GET', '/episode?seriesId=11', [
        { json: sonarrEpisodes() },
        { json: sonarrEpisodesAfterDelete([502]) },
      ]),
      route('GET', '/release?episodeId=102', { json: [goodRelease()] }),
      route('DELETE', '/episodefile/502', { json: {} }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 50, name: 'EpisodeSearch', status: 'queued' }] }),
    ]);

    await invoke(sonarr_replace, { tmdbId: 603, seasonNumber: 1, episodeNumber: 2 });
    const duplicate = await invoke(sonarr_replace, { tmdbId: 603, seasonNumber: 1, episodeNumber: 2 });

    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(JSON.parse((duplicate.content[0] as { text: string }).text)).toMatchObject({
      idempotent: true,
      duplicate: true,
      status: 'completed',
      key: 'sonarr_replace:603:1:2:false:false:auto:any',
    });
  });

  it('can grab a selected better release for a single episode', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      routeSequence('GET', '/episode?seriesId=11', [
        { json: sonarrEpisodes() },
        { json: sonarrEpisodesAfterDelete([502]) },
      ]),
      route('GET', '/release?episodeId=102', { json: [sdRelease(), goodRelease()] }),
      route('DELETE', '/episodefile/502', { json: {} }),
      route('POST', '/release', { json: { id: 200, status: 'queued' } }),
    ]);

    const result = await invoke(sonarr_replace, {
      tmdbId: 603,
      seasonNumber: 1,
      episodeNumber: 2,
      selectedReleaseGuid: 'good-guid',
      selectedReleaseIndexerId: 7,
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(calls.some((c) => c.method === 'POST' && new URL(c.url).pathname === '/api/v3/command')).toBe(false);
    const releasePost = calls.find((c) => c.method === 'POST' && new URL(c.url).pathname === '/api/v3/release');
    expect(releasePost?.body).toMatchObject({
      guid: 'good-guid',
      indexerId: 7,
      title: 'Severance.S01E02.1080p.WEB.h264-GROUP',
    });
    expect(parsed).toMatchObject({
      replacementMode: 'selected_release',
      grabbedRelease: {
        guid: 'good-guid',
        indexerId: 7,
        quality: 'WEB-1080p',
      },
      releaseGrab: { id: 200, status: 'queued' },
    });
  });

  it('refuses a selected episode release below the quality floor', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: sonarrEpisodes() }),
      route('GET', '/release?episodeId=102', { json: [sdRelease(), goodRelease()] }),
    ]);

    const result = await invoke(sonarr_replace, {
      tmdbId: 603,
      seasonNumber: 1,
      episodeNumber: 2,
      selectedReleaseGuid: 'sd-guid',
      selectedReleaseIndexerId: 7,
    });

    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(JSON.parse((result.content[0] as { text: string }).text).error).toMatch(/Selected Sonarr candidate is SDTV/);
  });
});

describe('sonarr_replace (full season)', () => {
  it('deletes every episode-with-file in the season, then triggers SeasonSearch', async () => {
    const { calls } = installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      routeSequence('GET', '/episode?seriesId=11', [
        { json: sonarrEpisodes() },
        { json: sonarrEpisodesAfterDelete([501, 502]) },
      ]),
      route('DELETE', '/episodefile/501', { json: {} }),
      route('DELETE', '/episodefile/502', { json: {} }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 50, name: 'SeasonSearch', status: 'queued' }] }),
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
      routeSequence('GET', '/episode?seriesId=11', [
        { json: sonarrEpisodes() },
        { json: sonarrEpisodes() },
      ]),
      route('GET', '/release?episodeId=101', { json: [goodRelease()] }),
      route('POST', '/command', { json: { id: 50, status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 50, name: 'EpisodeSearch', status: 'queued' }] }),
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

describe('sonarr_episode_replacement_candidates', () => {
  it('shows current episode file and release candidates', async () => {
    installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: sonarrEpisodes() }),
      route('GET', '/release?episodeId=102', { json: [sdRelease(), goodRelease()] }),
    ]);

    const result = await invoke(sonarr_episode_replacement_candidates, {
      tmdbId: 603,
      seasonNumber: 1,
      episodeNumber: 2,
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.summary).toMatch(/2 Sonarr replacement candidates/);
    expect(parsed.currentFile).toMatchObject({
      episodeFileId: 502,
      quality: 'WEB-1080p',
      qualityRank: 3000,
    });
    expect(parsed.items[0]).toMatchObject({
      guid: 'sd-guid',
      indexerId: 7,
      quality: 'SDTV',
      score: 20000,
    });
    expect(parsed.safety).toMatchObject({
      replacementFloor: '1080p',
      topCandidateBelowFloor: true,
    });
  });

  it('shows rejected candidates when no automatic candidate is acceptable', async () => {
    installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: sonarrEpisodes() }),
      route('GET', '/release?episodeId=102', { json: [rejectedGoodRelease()] }),
    ]);

    const result = await invoke(sonarr_episode_replacement_candidates, {
      tmdbId: 603,
      seasonNumber: 1,
      episodeNumber: 2,
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.items[0]).toMatchObject({
      guid: 'rejected-good-guid',
      quality: 'WEB-1080p',
      rejected: true,
      rejections: ['Quality profile does not allow WEB-1080p'],
    });
    expect(parsed.safety).toMatchObject({
      acceptableCandidateCount: 0,
      noAcceptableCandidates: true,
    });
  });
});

describe('sonarr_file_quality_check', () => {
  it('lists low-quality and missing files for a whole season and recommends season search', async () => {
    installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: mixedQualityEpisodes() }),
    ]);

    const result = await invoke(sonarr_file_quality_check, {
      tmdbId: 603,
      seasonNumber: 1,
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.summary).toMatch(/2 Sonarr quality issue/);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      episodeNumber: 2,
      quality: 'SDTV',
      flags: ['quality below 1080p'],
      needsUpgrade: true,
    });
    expect(parsed.items[1]).toMatchObject({
      episodeNumber: 3,
      hasFile: false,
      flags: ['missing file'],
      needsUpgrade: true,
    });
    expect(parsed.recommendedActions[0]).toMatchObject({
      label: 'Whole-season automatic search',
      tool: 'sonarr_replace',
      args: { tmdbId: 603, seasonNumber: 1, keepFile: true },
    });
  });

  it('can check one exact episode and recommend candidate inspection', async () => {
    installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: mixedQualityEpisodes() }),
    ]);

    const result = await invoke(sonarr_file_quality_check, {
      tmdbId: 603,
      seasonNumber: 1,
      episodeNumber: 2,
      minQuality: '720p',
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.summary).toMatch(/1 Sonarr quality issue/);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      seasonNumber: 1,
      episodeNumber: 2,
      quality: 'SDTV',
      flags: ['quality below 720p'],
    });
    expect(parsed.recommendedActions[0]).toMatchObject({
      label: 'Inspect exact episode candidates',
      tool: 'sonarr_episode_replacement_candidates',
      args: { tmdbId: 603, seasonNumber: 1, episodeNumber: 2 },
    });
  });
});

describe('guardReplace', () => {
  it('blocks automatic single-episode replacement before confirmation when no non-rejected candidates exist', async () => {
    installFetchMock([
      route('GET', '/api/v1/tv/603', { json: tvDetail() }),
      route('GET', '/series?tvdbId=1234', { json: sonarrSeries() }),
      route('GET', '/episode?seriesId=11', { json: sonarrEpisodes() }),
      route('GET', '/release?episodeId=102', { json: [rejectedGoodRelease()] }),
    ]);

    const result = await guardReplace({ tmdbId: 603, seasonNumber: 1, episodeNumber: 2 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/sonarr_episode_replacement_candidates/);
      expect(result.lines.join('\n')).toMatch(/Automatic Sonarr replacement blocked/);
    }
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
