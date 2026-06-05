import { beforeEach, describe, expect, it } from 'vitest';
import {
  plex_apply_match,
  plex_check_presence,
  plex_collecting_dust,
  plex_list_users,
  plex_quality_audit,
  plex_quality_profile,
  plex_search,
  plex_similar,
  plex_unwatched,
  plex_watch_history,
} from './plex.js';
import { installFetchMock, invoke, route } from './_testing.js';
import { resetIdempotencyForTests } from './idempotency.js';

beforeEach(() => {
  resetIdempotencyForTests();
});

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

  it('accepts natural section and sort aliases', async () => {
    const { calls } = installFetchMock([
      route('GET', '/library/sections/2/unwatched', {
        json: {
          MediaContainer: {
            Metadata: [{ title: 'Severance', type: 'show', year: 2022, audienceRating: 9.1 }],
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

    const result = await invoke(plex_unwatched, { section: 'series', sort: 'top_rated' });

    const unwatched = calls.find((c) => c.url.includes('/unwatched'));
    expect(unwatched).toBeDefined();
    const url = new URL(unwatched?.url ?? '');
    expect(url.pathname).toBe('/library/sections/2/unwatched');
    expect(url.searchParams.get('sort')).toBe('audienceRating:desc');

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.summary).toMatch(/shows, sort: highest_rated/);
  });
});

describe('plex_quality_profile', () => {
  it('returns container, codec, resolution, file size, path, and audio tracks', async () => {
    installFetchMock([
      route('GET', '/library/metadata/777', {
        json: {
          MediaContainer: {
            Metadata: [
              {
                ratingKey: '777',
                title: 'Dune',
                type: 'movie',
                year: 2021,
                Media: [
                  {
                    bitrate: 8100,
                    width: 3840,
                    height: 2160,
                    videoCodec: 'hevc',
                    Part: [
                      {
                        file: '/media/Dune.mkv',
                        size: 25 * 1024 ** 3,
                        container: 'mkv',
                        Stream: [
                          { streamType: 1, codec: 'hevc', width: 3840, height: 2160 },
                          {
                            streamType: 2,
                            codec: 'truehd',
                            channels: 8,
                            audioChannelLayout: '7.1',
                            languageCode: 'eng',
                            title: 'English TrueHD 7.1',
                            bitrate: 4200,
                            selected: true,
                            default: true,
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
    ]);

    const result = await invoke(plex_quality_profile, { ratingKey: '777' });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed).toMatchObject({
      ratingKey: '777',
      title: 'Dune (2021)',
      container: 'mkv',
      videoCodec: 'hevc',
      resolution: '2160p',
      bitrateKbps: 8100,
      fileSizeGiB: 25,
      path: '/media/Dune.mkv',
    });
    expect(parsed.audioTracks).toEqual([
      {
        codec: 'truehd',
        profile: null,
        channels: 8,
        layout: '7.1',
        language: 'eng',
        title: 'English TrueHD 7.1',
        bitrateKbps: 4200,
        selected: true,
        default: true,
      },
    ]);
  });
});

describe('plex_quality_audit', () => {
  it('flags likely low-quality movie files and sorts weakest first', async () => {
    const { calls } = installFetchMock([
      route('GET', '/library/sections/1/all', {
        json: {
          MediaContainer: {
            Metadata: [
              {
                ratingKey: '1',
                title: 'Good 4K',
                type: 'movie',
                year: 2023,
                Media: [
                  {
                    bitrate: 16000,
                    width: 3840,
                    height: 2160,
                    videoCodec: 'hevc',
                    Part: [{ file: '/media/Good.mkv', size: 32 * 1024 ** 3, container: 'mkv', Stream: [] }],
                  },
                ],
              },
              {
                ratingKey: '2',
                title: 'Tiny 720p',
                type: 'movie',
                year: 1998,
                Media: [
                  {
                    bitrate: 1800,
                    width: 1280,
                    height: 720,
                    videoCodec: 'h264',
                    Part: [
                      {
                        file: '/media/Tiny.mp4',
                        size: 1.4 * 1024 ** 3,
                        container: 'mp4',
                        Stream: [
                          { streamType: 1, codec: 'h264', width: 1280, height: 720 },
                          { streamType: 2, codec: 'aac', channels: 2, languageCode: 'eng' },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
      route('GET', '/library/sections', {
        json: {
          MediaContainer: {
            Directory: [{ key: '1', type: 'movie', title: 'Movies' }],
          },
        },
      }),
    ]);

    const result = await invoke(plex_quality_audit, {
      section: 'movies',
      minHeight: 1080,
      minBitrateKbps: 2500,
      preferredVideoCodecs: ['hevc', 'av1'],
      preferredContainers: ['mkv'],
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(calls.some((c) => c.url.includes('/library/sections/1/all'))).toBe(true);
    expect(parsed.summary).toBe('1 quality issue (movies)');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      title: 'Tiny 720p (1998)',
      container: 'mp4',
      videoCodec: 'h264',
      resolution: '720p',
      bitrateKbps: 1800,
      fileSizeGiB: 1.4,
      flags: [
        'resolution below 1080p',
        'bitrate below 2500 kbps',
        'video codec is h264',
        'container is mp4',
      ],
    });
  });

  it('audits show sections as episode files', async () => {
    const { calls } = installFetchMock([
      route('GET', '/library/sections/2/all', {
        json: {
          MediaContainer: {
            Metadata: [
              {
                ratingKey: '9',
                title: 'Pilot',
                type: 'episode',
                grandparentTitle: 'Severance',
                parentIndex: 1,
                index: 1,
                Media: [
                  {
                    height: 480,
                    videoCodec: 'h264',
                    Part: [{ container: 'mkv', Stream: [{ streamType: 2, codec: 'aac', channels: 2 }] }],
                  },
                ],
              },
            ],
          },
        },
      }),
      route('GET', '/library/sections', {
        json: {
          MediaContainer: {
            Directory: [{ key: '2', type: 'show', title: 'TV Shows' }],
          },
        },
      }),
    ]);

    const result = await invoke(plex_quality_audit, { section: 'shows', minHeight: 720 });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    const allCall = calls.find((c) => c.url.includes('/library/sections/2/all'));
    const url = new URL(allCall?.url ?? '');

    expect(url.searchParams.get('type')).toBe('4');
    expect(parsed.items[0].title).toBe('Severance S01E01 - Pilot');
    expect(parsed.items[0].flags).toEqual(['resolution below 720p']);
  });
});

describe('plex_list_users', () => {
  it('returns id and name for each Plex account', async () => {
    installFetchMock([
      route('GET', '/accounts', {
        json: {
          MediaContainer: {
            Account: [
              { id: 1, name: 'admin', title: 'Admin' },
              { id: 42, name: 'Feelsgooodjpeg', title: 'Feels' },
            ],
          },
        },
      }),
    ]);

    const result = await invoke(plex_list_users, {});
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.summary).toMatch(/2 Plex accounts/);
    expect(parsed.items).toEqual([
      { id: 1, name: 'admin' },
      { id: 42, name: 'Feelsgooodjpeg' },
    ]);
  });
});

describe('plex_watch_history', () => {
  it('returns server-wide history when no user is given', async () => {
    const { calls } = installFetchMock([
      route('GET', '/status/sessions/history/all', {
        json: {
          MediaContainer: {
            Metadata: [{ title: 'Dune', type: 'movie', year: 2021, viewedAt: 1700000000 }],
          },
        },
      }),
    ]);

    const result = await invoke(plex_watch_history, { count: 5 });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    const historyCall = calls.find((c) => c.url.includes('/status/sessions/history/all'));
    expect(historyCall).toBeDefined();
    const url = new URL(historyCall?.url ?? '');
    expect(url.searchParams.has('accountID')).toBe(false);
    expect(url.searchParams.get('X-Plex-Container-Size')).toBe('5');
    expect(parsed.summary).toBe('1 recent watch event');
    expect(parsed.items[0].title).toBe('Dune');
  });

  it('resolves a username to accountID and scopes history to that user', async () => {
    const { calls } = installFetchMock([
      // Most specific first.
      route('GET', '/status/sessions/history/all', {
        json: {
          MediaContainer: {
            Metadata: [
              {
                type: 'episode',
                grandparentTitle: 'House of the Dragon',
                parentIndex: 2,
                index: 1,
                title: 'A Son for a Son',
                viewedAt: 1700000000,
              },
            ],
          },
        },
      }),
      route('GET', '/accounts', {
        json: {
          MediaContainer: {
            Account: [
              { id: 1, name: 'admin', title: 'Admin' },
              { id: 42, name: 'Feelsgooodjpeg', title: 'Feels' },
            ],
          },
        },
      }),
    ]);

    const result = await invoke(plex_watch_history, { user: 'Feelsgooodjpeg' });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    const historyCall = calls.find((c) => c.url.includes('/status/sessions/history/all'));
    const url = new URL(historyCall?.url ?? '');
    expect(url.searchParams.get('accountID')).toBe('42');

    expect(parsed.summary).toBe('1 recent watch event for Feelsgooodjpeg (accountID 42)');
    expect(parsed.items[0].title).toBe('House of the Dragon S02E01 – A Son for a Son');
  });

  it('accepts a numeric user id directly', async () => {
    const { calls } = installFetchMock([
      route('GET', '/status/sessions/history/all', {
        json: { MediaContainer: { Metadata: [] } },
      }),
      route('GET', '/accounts', {
        json: {
          MediaContainer: {
            Account: [{ id: 42, name: 'Feelsgooodjpeg', title: 'Feels' }],
          },
        },
      }),
    ]);

    await invoke(plex_watch_history, { user: '42' });

    const historyCall = calls.find((c) => c.url.includes('/status/sessions/history/all'));
    const url = new URL(historyCall?.url ?? '');
    expect(url.searchParams.get('accountID')).toBe('42');
  });

  it('errors with the known account list when the username does not match', async () => {
    installFetchMock([
      route('GET', '/accounts', {
        json: {
          MediaContainer: {
            Account: [{ id: 1, name: 'admin', title: 'Admin' }],
          },
        },
      }),
    ]);

    const result = await invoke(plex_watch_history, { user: 'ghost' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toMatch(/No Plex account matches "ghost"/);
    expect(parsed.error).toMatch(/admin/);
  });
});

describe('plex_collecting_dust', () => {
  it('queries unwatched sorted oldest-first and surfaces ratingKeys', async () => {
    const { calls } = installFetchMock([
      route('GET', '/library/sections/1/unwatched', {
        json: {
          MediaContainer: {
            Metadata: [
              { ratingKey: '11', title: 'Forgotten Gem', type: 'movie', year: 2009, addedAt: 1500000000, audienceRating: 8.4 },
              { ratingKey: '12', title: 'Forgotten Dud', type: 'movie', year: 2010, addedAt: 1500050000, audienceRating: 5.1 },
            ],
          },
        },
      }),
      route('GET', '/library/sections', {
        json: { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }] } },
      }),
    ]);

    const result = await invoke(plex_collecting_dust, { section: 'movies', count: 5 });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    const unwatchedCall = calls.find((c) => c.url.includes('/unwatched'));
    const url = new URL(unwatchedCall?.url ?? '');
    expect(url.searchParams.get('sort')).toBe('addedAt:asc');
    expect(url.searchParams.get('X-Plex-Container-Size')).toBe('5');

    expect(parsed.summary).toMatch(/2 dusty unwatched items \(movies\)/);
    expect(parsed.items[0]).toMatchObject({
      ratingKey: '11',
      title: 'Forgotten Gem',
      audienceRating: 8.4,
    });
  });

  it('drops items below minRating and overfetches to keep the result count', async () => {
    const { calls } = installFetchMock([
      route('GET', '/library/sections/1/unwatched', {
        json: {
          MediaContainer: {
            Metadata: [
              { ratingKey: '1', title: 'Cheap A', type: 'movie', year: 2000, addedAt: 1, audienceRating: 5 },
              { ratingKey: '2', title: 'Great B', type: 'movie', year: 2001, addedAt: 2, audienceRating: 8.5 },
              { ratingKey: '3', title: 'Cheap C', type: 'movie', year: 2002, addedAt: 3, audienceRating: 4 },
              { ratingKey: '4', title: 'Unrated D', type: 'movie', year: 2003, addedAt: 4 },
            ],
          },
        },
      }),
      route('GET', '/library/sections', {
        json: { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }] } },
      }),
    ]);

    const result = await invoke(plex_collecting_dust, { section: 'movies', count: 3, minRating: 7 });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    const unwatchedCall = calls.find((c) => c.url.includes('/unwatched'));
    const url = new URL(unwatchedCall?.url ?? '');
    // Overfetched to 4x the requested limit (3*4=12).
    expect(url.searchParams.get('X-Plex-Container-Size')).toBe('12');

    expect(parsed.summary).toMatch(/1 dusty unwatched item \(movies, audienceRating ≥ 7\)/);
    expect(parsed.items).toEqual([
      expect.objectContaining({ ratingKey: '2', title: 'Great B', audienceRating: 8.5 }),
    ]);
  });
});

describe('plex_similar', () => {
  it('queries /library/metadata/{ratingKey}/similar and returns ratingKeys', async () => {
    const { calls } = installFetchMock([
      route('GET', '/library/metadata/9000/similar', {
        json: {
          MediaContainer: {
            Metadata: [
              { ratingKey: '101', title: 'Arrival', type: 'movie', year: 2016, audienceRating: 8.1 },
              { ratingKey: '102', title: 'Annihilation', type: 'movie', year: 2018, audienceRating: 7.5 },
            ],
          },
        },
      }),
    ]);

    const result = await invoke(plex_similar, { ratingKey: '9000', count: 5 });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(calls.some((c) => c.url.includes('/library/metadata/9000/similar'))).toBe(true);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('X-Plex-Container-Size')).toBe('5');

    expect(parsed.summary).toMatch(/2 similar library items/);
    expect(parsed.items).toEqual([
      expect.objectContaining({ ratingKey: '101', title: 'Arrival', audienceRating: 8.1 }),
      expect.objectContaining({ ratingKey: '102', title: 'Annihilation', audienceRating: 7.5 }),
    ]);
  });
});

describe('plex_check_presence', () => {
  const sectionsResponse = {
    MediaContainer: {
      Directory: [
        { key: '10', type: 'movie', title: 'Movies' },
        { key: '11', type: 'show', title: 'TV Shows' },
      ],
    },
  };

  const movieLibrary = {
    MediaContainer: {
      Metadata: [
        {
          ratingKey: '111',
          title: 'The Fly',
          type: 'movie',
          year: 1986,
          Guid: [{ id: 'imdb://tt0091064' }, { id: 'tmdb://9426' }],
        },
        {
          ratingKey: '222',
          title: 'Carrie',
          type: 'movie',
          year: 1976,
          Guid: [{ id: 'imdb://tt0074285' }, { id: 'tmdb://7340' }],
        },
        {
          // No Guid array — only matchable by title+year.
          ratingKey: '333',
          title: 'Wait Until Dark',
          type: 'movie',
          year: 1967,
        },
      ],
    },
  };

  it('matches by imdb, tmdb, and title+year, and returns presentCount / missingCount', async () => {
    const { calls } = installFetchMock([
      route('GET', '/library/sections/10/all', { json: movieLibrary }),
      route('GET', '/library/sections', { json: sectionsResponse }),
    ]);

    const result = await invoke(plex_check_presence, {
      section: 'movies',
      items: [
        { imdbId: 'tt0091064', title: 'The Fly', year: 1986 }, // matched by imdb
        { tmdbId: 7340, title: 'Carrie', year: 1976 }, // matched by tmdb
        { title: 'Wait Until Dark', year: 1967 }, // matched by title+year fallback
        { tmdbId: 99999, title: 'Made-up Horror', year: 2024 }, // missing
      ],
    });

    // includeGuids should be set on the library fetch.
    const libCall = calls.find((c) => c.url.includes('/library/sections/10/all'));
    expect(libCall?.url).toContain('includeGuids=1');

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.presentCount).toBe(3);
    expect(payload.missingCount).toBe(1);
    expect(payload.librarySize).toBe(3);
    expect(payload.summary).toContain('3/4 present');

    expect(payload.items).toEqual([
      expect.objectContaining({ inLibrary: true, matchedBy: 'imdb', plexRatingKey: '111', plexTitle: 'The Fly' }),
      expect.objectContaining({ inLibrary: true, matchedBy: 'tmdb', plexRatingKey: '222', plexTitle: 'Carrie' }),
      expect.objectContaining({ inLibrary: true, matchedBy: 'title', plexRatingKey: '333', plexTitle: 'Wait Until Dark' }),
      expect.objectContaining({ inLibrary: false, tmdbId: 99999, title: 'Made-up Horror' }),
    ]);
  });

  it('filters output when returnOnly is "missing"', async () => {
    installFetchMock([
      route('GET', '/library/sections/10/all', { json: movieLibrary }),
      route('GET', '/library/sections', { json: sectionsResponse }),
    ]);

    const result = await invoke(plex_check_presence, {
      section: 'movies',
      returnOnly: 'missing',
      items: [
        { imdbId: 'tt0091064' }, // present, should be filtered out
        { tmdbId: 99999, title: 'Nope', year: 2024 },
      ],
    });

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.presentCount).toBe(1);
    expect(payload.missingCount).toBe(1);
    expect(payload.items).toEqual([
      expect.objectContaining({ inLibrary: false, tmdbId: 99999 }),
    ]);
    expect(payload.summary).toContain('returning missing only');
  });

  it('fetches once per matching section, not per input item', async () => {
    const { calls } = installFetchMock([
      route('GET', '/library/sections/10/all', { json: movieLibrary }),
      route('GET', '/library/sections', { json: sectionsResponse }),
    ]);

    const manyInputs = Array.from({ length: 50 }, (_, i) => ({ tmdbId: 9000 + i }));
    await invoke(plex_check_presence, { section: 'movies', items: manyInputs });

    // One sections call + one per section, regardless of input size.
    const libraryCalls = calls.filter((c) => c.url.includes('/library/sections/10/all'));
    expect(libraryCalls).toHaveLength(1);
  });
});
