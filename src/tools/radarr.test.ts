import { describe, expect, it, beforeEach } from 'vitest';
import { guardReplaceMovie, radarr_replace_movie, radarr_replacement_candidates } from './radarr.js';
import { installFetchMock, invoke, route, routeSequence } from './_testing.js';
import { resetIdempotencyForTests } from './idempotency.js';

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

function goodRelease() {
  return {
    guid: 'good-guid',
    indexerId: 3,
    title: 'The.Matrix.1999.1080p.BluRay.x264-GROUP',
    indexer: 'NZBgeek',
    size: 14 * 1024 ** 3,
    age: 100,
    quality: { quality: { name: 'Bluray-1080p' } },
    customFormatScore: 200,
    rejected: false,
    rejections: [],
  };
}

function rejectedGoodRelease() {
  return {
    ...goodRelease(),
    guid: 'rejected-good-guid',
    rejected: true,
    rejections: ['Quality profile does not allow Bluray-1080p'],
  };
}

function dvdRelease() {
  return {
    guid: 'dvd-guid',
    indexerId: 3,
    title: 'The.Matrix.1999.DVDRip.XviD-GROUP',
    indexer: 'NZBgeek',
    size: 900 * 1024 ** 2,
    age: 4000,
    quality: { quality: { name: 'DVD' } },
    customFormatScore: 20_000,
    rejected: false,
    rejections: [],
  };
}

describe('radarr_replace_movie', () => {
  beforeEach(() => {
    resetIdempotencyForTests();
  });

  it('deletes the existing file BEFORE triggering the search command', async () => {
    const { calls } = installFetchMock([
      routeSequence('GET', '/movie?tmdbId=603', [
        { json: radarrMovie() },
        { json: radarrMovie({ hasFile: false }) },
      ]),
      route('GET', '/release?movieId=42', { json: [goodRelease()] }),
      route('DELETE', '/moviefile/7', { json: {} }),
      route('POST', '/command', { json: { id: 99, name: 'MoviesSearch', status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 99, name: 'MoviesSearch', status: 'queued' }] }),
    ]);

    const result = await invoke(radarr_replace_movie, { tmdbId: 603 });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`))
      .toEqual([
        'GET /api/v3/movie?tmdbId=603',
        'GET /api/v3/release?movieId=42',
        'DELETE /api/v3/moviefile/7',
        'POST /api/v3/command',
        'GET /api/v3/movie?tmdbId=603',
        'GET /api/v3/command',
      ]);
    expect(calls[3].body).toEqual({ name: 'MoviesSearch', movieIds: [42] });
    expect(JSON.parse((result.content[0] as { text: string }).text).selfCheck).toMatchObject({
      ok: true,
      hasFileAfter: false,
      fileStateOk: true,
      searchCommandVisible: true,
    });
  });

  it('skips the DELETE when keepFile=true and still triggers search', async () => {
    const { calls } = installFetchMock([
      routeSequence('GET', '/movie?tmdbId=603', [
        { json: radarrMovie() },
        { json: radarrMovie() },
      ]),
      route('GET', '/release?movieId=42', { json: [goodRelease()] }),
      route('POST', '/command', { json: { id: 99, name: 'MoviesSearch', status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 99, name: 'MoviesSearch', status: 'queued' }] }),
    ]);

    await invoke(radarr_replace_movie, { tmdbId: 603, keepFile: true });

    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'GET']);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('skips the DELETE when the movie has no file currently', async () => {
    const { calls } = installFetchMock([
      routeSequence('GET', '/movie?tmdbId=603', [
        { json: radarrMovie({ hasFile: false }) },
        { json: radarrMovie({ hasFile: false }) },
      ]),
      route('GET', '/release?movieId=42', { json: [goodRelease()] }),
      route('POST', '/command', { json: { id: 99, name: 'MoviesSearch', status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 99, name: 'MoviesSearch', status: 'queued' }] }),
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

  it('does not delete or trigger search twice for duplicate same-arg calls', async () => {
    const { calls } = installFetchMock([
      routeSequence('GET', '/movie?tmdbId=603', [
        { json: radarrMovie() },
        { json: radarrMovie({ hasFile: false }) },
      ]),
      route('GET', '/release?movieId=42', { json: [goodRelease()] }),
      route('DELETE', '/moviefile/7', { json: {} }),
      route('POST', '/command', { json: { id: 99, name: 'MoviesSearch', status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 99, name: 'MoviesSearch', status: 'queued' }] }),
    ]);

    await invoke(radarr_replace_movie, { tmdbId: 603 });
    const duplicate = await invoke(radarr_replace_movie, { tmdbId: 603 });

    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(JSON.parse((duplicate.content[0] as { text: string }).text)).toMatchObject({
      idempotent: true,
      duplicate: true,
      status: 'completed',
      key: 'radarr_replace_movie:603:false:false:auto:any',
    });
  });

  it('runs materially different keepFile calls separately', async () => {
    const { calls } = installFetchMock([
      routeSequence('GET', '/movie?tmdbId=603', [
        { json: radarrMovie() },
        { json: radarrMovie({ hasFile: false }) },
        { json: radarrMovie({ hasFile: false }) },
        { json: radarrMovie({ hasFile: false }) },
      ]),
      route('GET', '/release?movieId=42', { json: [goodRelease()] }),
      route('DELETE', '/moviefile/7', { json: {} }),
      route('POST', '/command', { json: { id: 99, name: 'MoviesSearch', status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 99, name: 'MoviesSearch', status: 'queued' }] }),
    ]);

    await invoke(radarr_replace_movie, { tmdbId: 603 });
    await invoke(radarr_replace_movie, { tmdbId: 603, keepFile: true });

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('refuses to delete when Radarr top candidate is a quality downgrade', async () => {
    const { calls } = installFetchMock([
      route('GET', '/movie?tmdbId=603', { json: radarrMovie() }),
      route('GET', '/release?movieId=42', { json: [dvdRelease(), goodRelease()] }),
    ]);

    const result = await invoke(radarr_replace_movie, { tmdbId: 603 });

    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(JSON.parse((result.content[0] as { text: string }).text).error).toMatch(/below the replacement floor/);
  });

  it('can intentionally allow a downgrade when requested', async () => {
    const { calls } = installFetchMock([
      routeSequence('GET', '/movie?tmdbId=603', [
        { json: radarrMovie() },
        { json: radarrMovie({ hasFile: false }) },
      ]),
      route('GET', '/release?movieId=42', { json: [dvdRelease(), goodRelease()] }),
      route('DELETE', '/moviefile/7', { json: {} }),
      route('POST', '/command', { json: { id: 99, name: 'MoviesSearch', status: 'queued' } }),
      route('GET', '/command', { json: [{ id: 99, name: 'MoviesSearch', status: 'queued' }] }),
    ]);

    const result = await invoke(radarr_replace_movie, { tmdbId: 603, allowQualityDowngrade: true });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(parsed.replacementPreflight.ok).toBe(false);
    expect(parsed.replacementPreflight.topCandidate.quality).toBe('DVD');
  });

  it('can grab a selected better release even when the top scored release is worse', async () => {
    const { calls } = installFetchMock([
      routeSequence('GET', '/movie?tmdbId=603', [
        { json: radarrMovie() },
        { json: radarrMovie({ hasFile: false }) },
      ]),
      route('GET', '/release?movieId=42', { json: [dvdRelease(), goodRelease()] }),
      route('DELETE', '/moviefile/7', { json: {} }),
      route('POST', '/release', { json: { id: 123, status: 'queued' } }),
    ]);

    const result = await invoke(radarr_replace_movie, {
      tmdbId: 603,
      selectedReleaseGuid: 'good-guid',
      selectedReleaseIndexerId: 3,
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && new URL(c.url).pathname === '/api/v3/command')).toBe(false);
    const releasePost = calls.find((c) => c.method === 'POST' && new URL(c.url).pathname === '/api/v3/release');
    expect(releasePost?.body).toMatchObject({
      guid: 'good-guid',
      indexerId: 3,
      title: 'The.Matrix.1999.1080p.BluRay.x264-GROUP',
    });
    expect(parsed).toMatchObject({
      replacementMode: 'selected_release',
      grabbedRelease: {
        guid: 'good-guid',
        indexerId: 3,
        quality: 'Bluray-1080p',
      },
      releaseGrab: { id: 123, status: 'queued' },
    });
    expect(parsed.replacementPreflight.ok).toBe(true);
  });

  it('refuses a selected release that is still below the quality floor', async () => {
    const { calls } = installFetchMock([
      route('GET', '/movie?tmdbId=603', { json: radarrMovie() }),
      route('GET', '/release?movieId=42', { json: [dvdRelease(), goodRelease()] }),
    ]);

    const result = await invoke(radarr_replace_movie, {
      tmdbId: 603,
      selectedReleaseGuid: 'dvd-guid',
      selectedReleaseIndexerId: 3,
    });

    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(JSON.parse((result.content[0] as { text: string }).text).error).toMatch(/Selected Radarr candidate is DVD/);
  });
});

describe('radarr_replacement_candidates', () => {
  it('shows current file and scored release candidates', async () => {
    installFetchMock([
      route('GET', '/movie?tmdbId=603', { json: radarrMovie() }),
      route('GET', '/release?movieId=42', { json: [dvdRelease(), goodRelease()] }),
    ]);

    const result = await invoke(radarr_replacement_candidates, { tmdbId: 603 });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.summary).toMatch(/2 Radarr replacement candidates/);
    expect(parsed.currentFile).toMatchObject({
      quality: 'Bluray-1080p',
      qualityRank: 3000,
    });
    expect(parsed.items[0]).toMatchObject({
      guid: 'dvd-guid',
      indexerId: 3,
      title: 'The.Matrix.1999.DVDRip.XviD-GROUP',
      quality: 'DVD',
      score: 20000,
    });
    expect(parsed.safety).toMatchObject({
      replacementFloor: '1080p',
      topCandidateBelowFloor: true,
    });
  });

  it('shows rejected/manual candidates when no automatic candidate is acceptable', async () => {
    installFetchMock([
      route('GET', '/movie?tmdbId=603', { json: radarrMovie() }),
      route('GET', '/release?movieId=42', { json: [rejectedGoodRelease()] }),
    ]);

    const result = await invoke(radarr_replacement_candidates, { tmdbId: 603 });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      guid: 'rejected-good-guid',
      quality: 'Bluray-1080p',
      rejected: true,
      rejections: ['Quality profile does not allow Bluray-1080p'],
    });
    expect(parsed.safety).toMatchObject({
      acceptableCandidateCount: 0,
      noAcceptableCandidates: true,
      replacementFloor: '1080p',
    });
  });
});

describe('guardReplaceMovie', () => {
  it('blocks automatic replacement before confirmation when there are no non-rejected candidates', async () => {
    installFetchMock([
      route('GET', '/movie?tmdbId=603', { json: radarrMovie() }),
      route('GET', '/release?movieId=42', { json: [rejectedGoodRelease()] }),
    ]);

    const result = await guardReplaceMovie({ tmdbId: 603 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/radarr_replacement_candidates/);
      expect(result.lines.join('\n')).toMatch(/Automatic Radarr replacement blocked/);
    }
  });
});
