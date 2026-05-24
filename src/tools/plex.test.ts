import { beforeEach, describe, expect, it } from 'vitest';
import {
  plex_apply_match,
  plex_quality_audit,
  plex_quality_profile,
  plex_search,
  plex_unwatched,
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
