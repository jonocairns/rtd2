import { tool } from './define.js';
import { z } from 'zod';
import { env } from '../env.js';
import { PlexClient } from '../clients/plex/client.js';
import { safe } from './errors.js';
import { once } from './idempotency.js';
import { envelope, plural } from './output.js';

function normalizeSection(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (['movie', 'film', 'films'].includes(normalized)) return 'movies';
  if (['show', 'tv', 'series', 'tvshow', 'tvshows'].includes(normalized)) return 'shows';
  return value;
}

function normalizeUnwatchedSort(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (['recent', 'newest', 'newly_added'].includes(normalized)) return 'recently_added';
  if (['top_rated', 'best_rated', 'rating', 'rated'].includes(normalized)) return 'highest_rated';
  if (['oldest', 'old'].includes(normalized)) return 'oldest_added';
  return normalized;
}

const sectionSchema = z.preprocess(normalizeSection, z.enum(['movies', 'shows', 'all']));

const unwatchedSortSchema = z.preprocess(
  normalizeUnwatchedSort,
  z.enum(['recently_added', 'highest_rated', 'random', 'oldest_added'])
);

async function plexApi<T = unknown>(
  path: string,
  params?: Record<string, string>,
  init?: RequestInit
): Promise<T> {
  if (!env.PLEX_URL || !env.PLEX_TOKEN) {
    throw new Error('PLEX_URL and PLEX_TOKEN must be set in .env to use Plex tools.');
  }

  const url = new URL(`${env.PLEX_URL}${path}`);
  url.searchParams.set('X-Plex-Token', env.PLEX_TOKEN);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    ...init,
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': env.PLEX_TOKEN,
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Plex ${res.status} ${res.statusText} at ${path}: ${body.slice(0, 200)}`);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

interface PlexGuid {
  id: string;
}

interface PlexMetadata {
  ratingKey?: string;
  title: string;
  type: string;
  year?: number;
  addedAt?: number;
  viewedAt?: number;
  audienceRating?: number;
  rating?: number;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  parentIndex?: number;
  index?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  librarySectionID?: number;
  guid?: string;
  Guid?: PlexGuid[];
  Media?: PlexMedia[];
}

interface PlexResponse {
  MediaContainer: {
    size?: number;
    Metadata?: PlexMetadata[];
  };
}

interface PlexMedia {
  id?: number;
  duration?: number;
  bitrate?: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
  audioChannels?: number;
  audioCodec?: string;
  videoCodec?: string;
  videoResolution?: string;
  container?: string;
  Part?: PlexPart[];
}

interface PlexPart {
  id?: number;
  file?: string;
  size?: number;
  container?: string;
  duration?: number;
  Stream?: PlexStream[];
}

interface PlexStream {
  id?: number;
  streamType?: number;
  streamTypeID?: number;
  codec?: string;
  profile?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  channels?: number;
  audioChannelLayout?: string;
  language?: string;
  languageCode?: string;
  displayTitle?: string;
  title?: string;
  selected?: boolean;
  default?: boolean;
}

function formatItem(m: PlexMetadata, dateField: 'addedAt' | 'viewedAt') {
  const ts = m[dateField];
  return {
    title:
      m.type === 'episode'
        ? `${m.grandparentTitle ?? '?'} S${String(m.parentIndex ?? 0).padStart(2, '0')}E${String(m.index ?? 0).padStart(2, '0')} – ${m.title}`
        : m.title,
    type: m.type,
    year: m.year ?? null,
    date: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null,
    ratingKey: m.ratingKey ?? null,
    ...(m.type === 'episode' && m.grandparentRatingKey
      ? { showRatingKey: m.grandparentRatingKey }
      : {}),
  };
}

export const plex_recently_added = tool(
  'plex_recently_added',
  'List recently added movies and TV episodes across all Plex libraries.',
  {
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of items to return (default 10)'),
  },
  safe(async ({ count }) => {
    const data = await plexApi<PlexResponse>('/library/recentlyAdded', {
      'X-Plex-Container-Start': '0',
      'X-Plex-Container-Size': String(count ?? 10),
    });

    const items = (data.MediaContainer.Metadata ?? []).map((m) => formatItem(m, 'addedAt'));

    return envelope(`${plural(items.length, 'recently added item')}`, items);
  }),
  { annotations: { readOnlyHint: true } }
);

interface PlexSection {
  key: string;
  type: string;
  title: string;
}

interface PlexSectionsResponse {
  MediaContainer: { Directory?: PlexSection[] };
}

async function listSections(): Promise<PlexSection[]> {
  const data = await plexApi<PlexSectionsResponse>('/library/sections');
  return data.MediaContainer.Directory ?? [];
}

function pickSections(sections: PlexSection[], filter: 'movies' | 'shows' | 'all'): PlexSection[] {
  return sections.filter((s) => {
    if (filter === 'all') return s.type === 'movie' || s.type === 'show';
    if (filter === 'movies') return s.type === 'movie';
    return s.type === 'show';
  });
}

async function fetchUnwatchedMetadata(opts: {
  sectionFilter: 'movies' | 'shows' | 'all';
  sortParam: string;
  pageSize: number;
}): Promise<{ wantedCount: number; collected: PlexMetadata[] }> {
  const sections = await listSections();
  const wanted = pickSections(sections, opts.sectionFilter);
  if (wanted.length === 0) return { wantedCount: 0, collected: [] };

  const responses = await Promise.all(
    wanted.map((sec) =>
      plexApi<PlexResponse>(`/library/sections/${sec.key}/unwatched`, {
        sort: opts.sortParam,
        'X-Plex-Container-Start': '0',
        'X-Plex-Container-Size': String(opts.pageSize),
      })
    )
  );
  return {
    wantedCount: wanted.length,
    collected: responses.flatMap((data) => data.MediaContainer.Metadata ?? []),
  };
}

export const plex_unwatched = tool(
  'plex_unwatched',
  'List unwatched titles in the Plex library. Use this for "what should I watch tonight" — combine with mdblist_ratings to surface highly-rated picks. Defaults to movies; pass section="shows" for unwatched/partially-watched series.',
  {
    section: sectionSchema
      .optional()
      .describe('Which library section type to query (default "movies"). Accepts movie/movies, show/shows, series, tv, or all.'),
    sort: unwatchedSortSchema
      .optional()
      .describe('Sort order. "highest_rated" uses Plex audience rating (default "recently_added"). Accepts aliases like top_rated, recent, newest, or oldest.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of items to return (default 15)'),
  },
  safe(async ({ section, sort, count }) => {
    const sectionFilter = (normalizeSection(section) as 'movies' | 'shows' | 'all' | undefined) ?? 'movies';
    const sortMode =
      (normalizeUnwatchedSort(sort) as 'recently_added' | 'highest_rated' | 'random' | 'oldest_added' | undefined) ??
      'recently_added';
    const limit = count ?? 15;

    const sortParam =
      sortMode === 'highest_rated'
        ? 'audienceRating:desc'
        : sortMode === 'random'
          ? 'random'
          : sortMode === 'oldest_added'
            ? 'addedAt:asc'
            : 'addedAt:desc';

    const { wantedCount, collected } = await fetchUnwatchedMetadata({
      sectionFilter,
      sortParam,
      pageSize: limit,
    });

    if (wantedCount === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ items: [], note: `No ${sectionFilter} sections found.` }, null, 2),
          },
        ],
      };
    }

    // Re-sort the merged list when we queried multiple sections (Plex sorts within each).
    if (wantedCount > 1 && sortMode !== 'random') {
      collected.sort((a, b) => {
        if (sortMode === 'highest_rated') {
          return (b.audienceRating ?? 0) - (a.audienceRating ?? 0);
        }
        const ax = a.addedAt ?? 0;
        const bx = b.addedAt ?? 0;
        return sortMode === 'oldest_added' ? ax - bx : bx - ax;
      });
    }

    const items = collected.slice(0, limit).map((m) => ({
      title: m.title,
      type: m.type,
      year: m.year ?? null,
      addedAt: m.addedAt ? new Date(m.addedAt * 1000).toISOString().slice(0, 10) : null,
      ...(typeof m.audienceRating === 'number' ? { audienceRating: m.audienceRating } : {}),
      ...(m.type === 'show' && typeof m.leafCount === 'number'
        ? {
            episodes: m.leafCount,
            watched: m.viewedLeafCount ?? 0,
          }
        : {}),
    }));

    return envelope(
      `${plural(items.length, 'unwatched item')} (${sectionFilter}, sort: ${sortMode})`,
      items
    );
  }),
  { annotations: { readOnlyHint: true } }
);

export const plex_collecting_dust = tool(
  'plex_collecting_dust',
  'Surface "hidden gem" library items that have been sitting around longest without being watched. Returns oldest-added unwatched titles, optionally filtered by minimum Plex audience rating so you skip the forgettable adds. Pair with mdblist_ratings for an external rating check.',
  {
    section: sectionSchema
      .optional()
      .describe('Which library section type to query (default "movies"). Accepts movie/movies, show/shows, series, tv, or all.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of items to return (default 15)'),
    minRating: z
      .number()
      .min(0)
      .max(10)
      .optional()
      .describe('Only include items whose Plex audienceRating is at least this value (0-10). Items with no audienceRating are dropped when this is set.'),
  },
  safe(async ({ section, count, minRating }) => {
    const sectionFilter = (normalizeSection(section) as 'movies' | 'shows' | 'all' | undefined) ?? 'movies';
    const limit = count ?? 15;
    // Overfetch when filtering by rating so we still hit `limit` after dropping
    // unrated/low-rated items.
    const pageSize = minRating !== undefined ? Math.min(50, limit * 4) : limit;

    const { wantedCount, collected } = await fetchUnwatchedMetadata({
      sectionFilter,
      sortParam: 'addedAt:asc',
      pageSize,
    });

    if (wantedCount === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ items: [], note: `No ${sectionFilter} sections found.` }, null, 2),
          },
        ],
      };
    }

    if (wantedCount > 1) {
      collected.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
    }

    const filtered =
      minRating === undefined
        ? collected
        : collected.filter(
            (m) => typeof m.audienceRating === 'number' && m.audienceRating >= minRating
          );

    const items = filtered.slice(0, limit).map((m) => ({
      ratingKey: m.ratingKey ?? null,
      title: m.title,
      type: m.type,
      year: m.year ?? null,
      addedAt: m.addedAt ? new Date(m.addedAt * 1000).toISOString().slice(0, 10) : null,
      ...(typeof m.audienceRating === 'number' ? { audienceRating: m.audienceRating } : {}),
      ...(m.type === 'show' && typeof m.leafCount === 'number'
        ? { episodes: m.leafCount, watched: m.viewedLeafCount ?? 0 }
        : {}),
    }));

    const ratingNote = minRating !== undefined ? `, audienceRating ≥ ${minRating}` : '';
    return envelope(
      `${plural(items.length, 'dusty unwatched item')} (${sectionFilter}${ratingNote})`,
      items
    );
  }),
  { annotations: { readOnlyHint: true } }
);

export const plex_similar = tool(
  'plex_similar',
  'Find Plex library items similar to a given item (uses Plex\'s built-in similarity based on shared genre, director, cast, etc). Pass the ratingKey from plex_search; for a show, use the show\'s ratingKey (not an episode\'s) — plex_watch_history surfaces `showRatingKey` for episodes you watched.',
  {
    ratingKey: z.string().describe("The Plex item's ratingKey to find similars for"),
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Max similar items to return (default 10)'),
  },
  safe(async ({ ratingKey, count }) => {
    const limit = count ?? 10;
    const data = await plexApi<PlexResponse>(`/library/metadata/${ratingKey}/similar`, {
      'X-Plex-Container-Start': '0',
      'X-Plex-Container-Size': String(limit),
    });

    const items = (data.MediaContainer.Metadata ?? []).slice(0, limit).map((m) => ({
      ratingKey: m.ratingKey ?? null,
      title: m.title,
      type: m.type,
      year: m.year ?? null,
      ...(typeof m.audienceRating === 'number' ? { audienceRating: m.audienceRating } : {}),
      addedAt: m.addedAt ? new Date(m.addedAt * 1000).toISOString().slice(0, 10) : null,
    }));

    return envelope(
      `${plural(items.length, 'similar library item')} (ratingKey ${ratingKey})`,
      items
    );
  }),
  { annotations: { readOnlyHint: true } }
);

interface PlexSearchHubResult {
  type?: string;
  Metadata?: PlexMetadata[];
}

interface PlexSearchResponse {
  MediaContainer: { Hub?: PlexSearchHubResult[]; Metadata?: PlexMetadata[] };
}

export const plex_search = tool(
  'plex_search',
  'Search the Plex library for items by title. Returns rating keys (Plex internal IDs) needed for plex_get_matches / plex_apply_match.',
  {
    query: z.string().describe('Title to search for'),
    count: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Max results to return (default 10)'),
  },
  safe(async ({ query, count }) => {
    const limit = count ?? 10;
    const data = await plexApi<PlexSearchResponse>('/search', { query });

    const flat: PlexMetadata[] = [];
    if (Array.isArray(data.MediaContainer.Hub)) {
      for (const hub of data.MediaContainer.Hub) {
        for (const item of hub.Metadata ?? []) flat.push(item);
      }
    }
    for (const item of data.MediaContainer.Metadata ?? []) flat.push(item);

    const items = flat
      .filter((m) => m.type === 'movie' || m.type === 'show' || m.type === 'episode')
      .slice(0, limit)
      .map((m) => ({
        ratingKey: m.ratingKey ?? null,
        title: m.title,
        type: m.type,
        year: m.year ?? null,
        guid: m.guid ?? null,
      }));

    return envelope(`${plural(items.length, 'Plex item')} matching "${query}"`, items);
  }),
  { annotations: { readOnlyHint: true } }
);

interface LibraryIndex {
  byImdb: Map<string, PlexMetadata>;
  byTmdb: Map<string, PlexMetadata>;
  byTvdb: Map<string, PlexMetadata>;
  byTitleYear: Map<string, PlexMetadata>;
  total: number;
}

function normalizeTitleKey(title: string, year?: number): string {
  // Lowercase, collapse non-alphanumerics — matches "The Fly!" against "The Fly" and survives ":"/"-" variants.
  const t = title.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${t}|${year ?? ''}`;
}

function indexLibrary(items: PlexMetadata[]): LibraryIndex {
  const byImdb = new Map<string, PlexMetadata>();
  const byTmdb = new Map<string, PlexMetadata>();
  const byTvdb = new Map<string, PlexMetadata>();
  const byTitleYear = new Map<string, PlexMetadata>();
  for (const m of items) {
    for (const g of m.Guid ?? []) {
      if (g.id.startsWith('imdb://')) byImdb.set(g.id.slice(7), m);
      else if (g.id.startsWith('tmdb://')) byTmdb.set(g.id.slice(7), m);
      else if (g.id.startsWith('tvdb://')) byTvdb.set(g.id.slice(7), m);
    }
    if (m.title && m.year) {
      const key = normalizeTitleKey(m.title, m.year);
      if (!byTitleYear.has(key)) byTitleYear.set(key, m);
    }
  }
  return { byImdb, byTmdb, byTvdb, byTitleYear, total: items.length };
}

async function loadLibraryIndex(filter: 'movies' | 'shows' | 'all'): Promise<LibraryIndex> {
  const sections = await listSections();
  const wanted = pickSections(sections, filter);
  if (wanted.length === 0) return { byImdb: new Map(), byTmdb: new Map(), byTvdb: new Map(), byTitleYear: new Map(), total: 0 };
  const responses = await Promise.all(
    wanted.map((sec) =>
      plexApi<PlexResponse>(`/library/sections/${sec.key}/all`, {
        'X-Plex-Container-Start': '0',
        'X-Plex-Container-Size': '100000',
        includeGuids: '1',
      })
    )
  );
  const all = responses.flatMap((data) => data.MediaContainer.Metadata ?? []);
  return indexLibrary(all);
}

export const plex_check_presence = tool(
  'plex_check_presence',
  'Batch-check whether titles are in the Plex library. Pass an array of identifiers (TMDb id preferred; IMDb id and TVDb id also matched; title+year is a fallback). Fetches the library once and diffs in-process — use this instead of looping plex_search for "what am I missing from this list of N titles". Pair with mdblist_list to import a curated list and identify gaps. Returns a per-input verdict plus presentCount / missingCount.',
  {
    items: z
      .array(
        z
          .object({
            tmdbId: z.number().int().optional(),
            imdbId: z.string().optional(),
            tvdbId: z.number().int().optional(),
            title: z.string().optional(),
            year: z.number().int().optional(),
            mediaType: z.enum(['movie', 'tv']).optional(),
          })
          .refine(
            (v) => v.tmdbId != null || v.imdbId != null || v.tvdbId != null || (v.title != null && v.year != null),
            { message: 'Each item needs at least one of: tmdbId, imdbId, tvdbId, or both title + year.' }
          )
      )
      .min(1)
      .max(5000)
      .describe('Items to check. Provide TMDb id when available; IMDb/TVDb/title+year are fallbacks.'),
    section: sectionSchema
      .optional()
      .describe('Which library section type to check against (default "all"). Accepts movie/movies, show/shows, series, tv, or all.'),
    returnOnly: z
      .enum(['all', 'missing', 'present'])
      .optional()
      .describe('Filter the returned items. Default "all" returns one row per input; "missing" or "present" prunes the response.'),
  },
  safe(async ({ items, section, returnOnly }) => {
    const filter = (normalizeSection(section ?? 'all') as 'movies' | 'shows' | 'all' | undefined) ?? 'all';
    if (!env.PLEX_URL || !env.PLEX_TOKEN) {
      throw new Error('PLEX_URL and PLEX_TOKEN must be set in .env to use Plex tools.');
    }
    const client = new PlexClient({ url: env.PLEX_URL, token: env.PLEX_TOKEN });
    const { index, verdicts } = await client.checkPresence(items, filter);

    const presentCount = verdicts.filter((v) => v.inLibrary).length;
    const missingCount = verdicts.length - presentCount;

    const mode = returnOnly ?? 'all';
    const selected =
      mode === 'missing' ? verdicts.filter((v) => !v.inLibrary) :
      mode === 'present' ? verdicts.filter((v) => v.inLibrary) :
      verdicts;

    const rows = selected.map((v) => {
      const base: Record<string, unknown> = {
        tmdbId: v.input.tmdbId ?? null,
        imdbId: v.input.imdbId ?? null,
        title: v.input.title ?? v.match?.title ?? null,
        year: v.input.year ?? v.match?.year ?? null,
        inLibrary: v.inLibrary,
      };
      if (v.inLibrary && v.match) {
        base.matchedBy = v.matchedBy;
        base.plexRatingKey = v.match.ratingKey ?? null;
        base.plexTitle = v.match.title;
        base.plexYear = v.match.year ?? null;
      }
      return base;
    });

    const summary = `${presentCount}/${items.length} present, ${missingCount} missing in Plex (library size: ${index.total}${returnOnly && returnOnly !== 'all' ? `, returning ${mode} only` : ''})`;

    return envelope(summary, rows, {
      presentCount,
      missingCount,
      librarySize: index.total,
      section: filter,
    });
  }),
  { annotations: { readOnlyHint: true } }
);

function bytesToGiB(size?: number): number | null {
  return typeof size === 'number' ? Number((size / 1024 ** 3).toFixed(2)) : null;
}

function normalizeCodec(value?: string): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (['h264', 'avc', 'avc1'].includes(normalized)) return 'h264';
  if (['h265', 'hevc', 'x265'].includes(normalized)) return 'hevc';
  return normalized;
}

function normalizeContainer(value?: string): string | null {
  return value ? value.toLowerCase() : null;
}

function qualityTitle(m: PlexMetadata): string {
  if (m.type === 'episode') {
    return `${m.grandparentTitle ?? m.title} S${String(m.parentIndex ?? 0).padStart(2, '0')}E${String(m.index ?? 0).padStart(2, '0')} - ${m.title}`;
  }
  return `${m.title}${m.year ? ` (${m.year})` : ''}`;
}

function streamsFor(media: PlexMedia | undefined, streamType: number): PlexStream[] {
  return (media?.Part ?? []).flatMap((part) =>
    (part.Stream ?? []).filter((stream) => (stream.streamType ?? stream.streamTypeID) === streamType)
  );
}

function formatAudioTrack(stream: PlexStream) {
  return {
    codec: normalizeCodec(stream.codec),
    profile: stream.profile ?? null,
    channels: stream.channels ?? null,
    layout: stream.audioChannelLayout ?? null,
    language: stream.languageCode ?? stream.language ?? null,
    title: stream.title ?? stream.displayTitle ?? null,
    bitrateKbps: stream.bitrate ?? null,
    selected: stream.selected ?? null,
    default: stream.default ?? null,
  };
}

function formatMediaProfile(m: PlexMetadata) {
  const media = m.Media?.[0];
  const part = media?.Part?.[0];
  const videoStream = streamsFor(media, 1)[0];
  const audioTracks = streamsFor(media, 2).map(formatAudioTrack);
  const container = normalizeContainer(part?.container ?? media?.container);
  const videoCodec = normalizeCodec(videoStream?.codec ?? media?.videoCodec);
  const width = videoStream?.width ?? media?.width ?? null;
  const height = videoStream?.height ?? media?.height ?? null;

  return {
    ratingKey: m.ratingKey ?? null,
    title: qualityTitle(m),
    type: m.type,
    container,
    videoCodec,
    resolution: height ? `${height}p` : (media?.videoResolution ?? null),
    width,
    height,
    bitrateKbps: media?.bitrate ?? videoStream?.bitrate ?? null,
    fileSizeGiB: bytesToGiB(part?.size),
    path: part?.file ?? null,
    audioTracks,
  };
}

function lowQualityFlags(
  profile: ReturnType<typeof formatMediaProfile>,
  opts: {
    minHeight: number;
    minBitrateKbps?: number;
    maxFileSizeGiB?: number;
    preferredVideoCodecs?: string[];
    preferredContainers?: string[];
  }
): string[] {
  const flags: string[] = [];
  if (typeof profile.height === 'number' && profile.height < opts.minHeight) {
    flags.push(`resolution below ${opts.minHeight}p`);
  }
  if (
    typeof opts.minBitrateKbps === 'number' &&
    typeof profile.bitrateKbps === 'number' &&
    profile.bitrateKbps < opts.minBitrateKbps
  ) {
    flags.push(`bitrate below ${opts.minBitrateKbps} kbps`);
  }
  if (
    typeof opts.maxFileSizeGiB === 'number' &&
    typeof profile.fileSizeGiB === 'number' &&
    profile.fileSizeGiB <= opts.maxFileSizeGiB
  ) {
    flags.push(`file size at or below ${opts.maxFileSizeGiB} GiB`);
  }
  if (
    opts.preferredVideoCodecs?.length &&
    profile.videoCodec &&
    !opts.preferredVideoCodecs.map(normalizeCodec).includes(profile.videoCodec)
  ) {
    flags.push(`video codec is ${profile.videoCodec}`);
  }
  if (
    opts.preferredContainers?.length &&
    profile.container &&
    !opts.preferredContainers.map(normalizeContainer).includes(profile.container)
  ) {
    flags.push(`container is ${profile.container}`);
  }
  return flags;
}

export const plex_quality_profile = tool(
  'plex_quality_profile',
  'Inspect the media file quality for one Plex item by ratingKey: container, video codec, resolution, bitrate, file size, path, and audio track details. Use plex_search first to find the ratingKey.',
  {
    ratingKey: z.string().describe("The Plex item's ratingKey from plex_search"),
  },
  safe(async ({ ratingKey }) => {
    const data = await plexApi<{ MediaContainer: { Metadata?: PlexMetadata[] } }>(
      `/library/metadata/${ratingKey}`
    );
    const item = data.MediaContainer.Metadata?.[0];
    if (!item) throw new Error(`No Plex item found for ratingKey ${ratingKey}.`);

    return {
      content: [{ type: 'text', text: JSON.stringify(formatMediaProfile(item), null, 2) }],
    };
  }),
  { annotations: { readOnlyHint: true } }
);

export const plex_quality_audit = tool(
  'plex_quality_audit',
  'Audit Plex media files for likely low-quality downloads. Returns titles with container, video codec, resolution, bitrate, file size, audio track details, and flags such as low resolution, low bitrate, small file, non-preferred codec, or non-preferred container.',
  {
    section: sectionSchema
      .optional()
      .describe('Which library section type to audit (default movies). Use shows to audit episode files.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum low-quality items to return after filtering and sorting (default 50).'),
    minHeight: z
      .number()
      .int()
      .min(1)
      .max(4320)
      .optional()
      .describe('Flag items below this vertical resolution in pixels (default 1080).'),
    minBitrateKbps: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Optional: flag items below this overall media bitrate in kbps when Plex reports bitrate.'),
    maxFileSizeGiB: z
      .number()
      .positive()
      .optional()
      .describe('Optional: flag items at or below this file size in GiB.'),
    preferredVideoCodecs: z
      .array(z.string())
      .optional()
      .describe('Optional preferred video codecs such as ["hevc","av1"]. Items outside this set are flagged.'),
    preferredContainers: z
      .array(z.string())
      .optional()
      .describe('Optional preferred containers such as ["mkv","mp4"]. Items outside this set are flagged.'),
  },
  safe(async ({
    section,
    count,
    minHeight,
    minBitrateKbps,
    maxFileSizeGiB,
    preferredVideoCodecs,
    preferredContainers,
  }) => {
    const sectionFilter = (normalizeSection(section) as 'movies' | 'shows' | 'all' | undefined) ?? 'movies';
    const limit = count ?? 50;
    const qualityFloor = minHeight ?? 1080;
    const sections = await listSections();
    const wanted = sections.filter((s) => {
      if (sectionFilter === 'all') return s.type === 'movie' || s.type === 'show';
      if (sectionFilter === 'movies') return s.type === 'movie';
      return s.type === 'show';
    });

    if (wanted.length === 0) {
      return envelope(`0 quality issues (${sectionFilter})`, [], {
        note: `No ${sectionFilter} sections found.`,
      });
    }

    const responses = await Promise.all(
      wanted.map((sec) => {
        const params: Record<string, string> = {
          sort: 'addedAt:desc',
          'X-Plex-Container-Start': '0',
          'X-Plex-Container-Size': '500',
        };
        if (sec.type === 'show') params.type = '4';
        return plexApi<PlexResponse>(`/library/sections/${sec.key}/all`, params);
      })
    );

    const audited = responses
      .flatMap((data) => data.MediaContainer.Metadata ?? [])
      .map((metadata) => {
        const profile = formatMediaProfile(metadata);
        return {
          ...profile,
          flags: lowQualityFlags(profile, {
            minHeight: qualityFloor,
            minBitrateKbps,
            maxFileSizeGiB,
            preferredVideoCodecs,
            preferredContainers,
          }),
        };
      })
      .filter((item) => item.flags.length > 0)
      .sort((a, b) => {
        const ah = a.height ?? 9999;
        const bh = b.height ?? 9999;
        if (ah !== bh) return ah - bh;
        return (a.bitrateKbps ?? 999999) - (b.bitrateKbps ?? 999999);
      })
      .slice(0, limit);

    return envelope(`${plural(audited.length, 'quality issue')} (${sectionFilter})`, audited, {
      rules: {
        minHeight: qualityFloor,
        minBitrateKbps: minBitrateKbps ?? null,
        maxFileSizeGiB: maxFileSizeGiB ?? null,
        preferredVideoCodecs: preferredVideoCodecs ?? null,
        preferredContainers: preferredContainers ?? null,
      },
    });
  }),
  { annotations: { readOnlyHint: true } }
);

interface PlexMatchCandidate {
  guid: string;
  name: string;
  year?: number;
  score?: number;
  lifespanEnded?: boolean;
  thumb?: string;
}

interface PlexMatchesResponse {
  MediaContainer: { SearchResult?: PlexMatchCandidate[] };
}

export const plex_get_matches = tool(
  'plex_get_matches',
  'Fetch alternative metadata matches Plex has identified for a library item (e.g. when the current match has wrong year, language, or is a different movie entirely). Use the ratingKey from plex_search.',
  {
    ratingKey: z.string().describe("The Plex item's ratingKey (from plex_search)"),
  },
  safe(async ({ ratingKey }) => {
    const data = await plexApi<PlexMatchesResponse>(`/library/metadata/${ratingKey}/matches`, {
      manual: '1',
    });

    const candidates = (data.MediaContainer.SearchResult ?? []).slice(0, 10).map((c) => ({
      guid: c.guid,
      name: c.name,
      year: c.year ?? null,
      score: c.score ?? null,
      lifespanEnded: c.lifespanEnded ?? null,
    }));

    return envelope(`${plural(candidates.length, 'candidate match', 'candidate matches')}`, candidates);
  }),
  { annotations: { readOnlyHint: true } }
);

export async function resolveApplyMatch(input: {
  ratingKey: string;
  guid: string;
  name?: string;
}): Promise<string[]> {
  const data = await plexApi<{ MediaContainer: { Metadata?: PlexMetadata[] } }>(
    `/library/metadata/${input.ratingKey}`
  );
  const item = data.MediaContainer.Metadata?.[0];
  const current = item
    ? `${item.title}${item.year ? ` (${item.year})` : ''} [${item.type}]`
    : `ratingKey ${input.ratingKey} (current item not found)`;

  return [
    'Apply match in Plex:',
    `  Current: ${current}`,
    `  New:     ${input.name ?? input.guid}`,
    `  Guid:    ${input.guid}`,
  ];
}

export const plex_apply_match = tool(
  'plex_apply_match',
  'Apply a chosen metadata match to a Plex library item, overriding the current (wrong) match. Get the guid from plex_get_matches. **MUTATING**: changes the library item\'s metadata.',
  {
    ratingKey: z.string().describe("The Plex item's ratingKey"),
    guid: z.string().describe('The match guid (from plex_get_matches)'),
    name: z.string().optional().describe('Display name for the match (recommended)'),
  },
  safe(async ({ ratingKey, guid, name }) =>
    once(`plex_apply_match:${ratingKey}:${guid}`, async () => {
      const params: Record<string, string> = { guid };
      if (name) params.name = name;
      await plexApi(`/library/metadata/${ratingKey}/match`, params, { method: 'PUT' });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ratingKey, applied: { guid, name: name ?? null } }, null, 2),
          },
        ],
      };
    })
  ),
  { annotations: { readOnlyHint: false } }
);

interface PlexAccount {
  id?: number;
  key?: string;
  name?: string;
  title?: string;
  thumb?: string;
}

interface PlexAccountsResponse {
  MediaContainer: { Account?: PlexAccount[] };
}

async function listAccounts(): Promise<PlexAccount[]> {
  const data = await plexApi<PlexAccountsResponse>('/accounts');
  return data.MediaContainer.Account ?? [];
}

function accountDisplayName(a: PlexAccount): string {
  return a.name ?? a.title ?? '';
}

async function resolveAccountId(user: string): Promise<{ id: number; name: string }> {
  const trimmed = user.trim();
  if (/^\d+$/.test(trimmed)) {
    const accounts = await listAccounts();
    const match = accounts.find((a) => String(a.id) === trimmed);
    return { id: Number(trimmed), name: match ? accountDisplayName(match) : trimmed };
  }

  const accounts = await listAccounts();
  const lower = trimmed.toLowerCase();
  const exact = accounts.find((a) => accountDisplayName(a).toLowerCase() === lower);
  const partial = exact ?? accounts.find((a) => accountDisplayName(a).toLowerCase().includes(lower));

  if (!partial || typeof partial.id !== 'number') {
    const known = accounts.map(accountDisplayName).filter(Boolean).join(', ');
    throw new Error(
      `No Plex account matches "${user}". Known accounts: ${known || '(none returned by /accounts)'}.`
    );
  }
  return { id: partial.id, name: accountDisplayName(partial) || trimmed };
}

export const plex_list_users = tool(
  'plex_list_users',
  'List Plex accounts that have access to this server (id, name). Use this to resolve a username to an accountID before calling plex_watch_history with a specific user.',
  {},
  safe(async () => {
    const accounts = await listAccounts();
    const items = accounts.map((a) => ({
      id: a.id ?? null,
      name: accountDisplayName(a) || null,
    }));
    return envelope(`${plural(items.length, 'Plex account')}`, items);
  }),
  { annotations: { readOnlyHint: true } }
);

export const plex_watch_history = tool(
  'plex_watch_history',
  'Show recently watched movies and TV episodes from Plex play history, newest first. Pass `user` (account name or numeric id) to scope to one Plex user; omit it for global server history. Use plex_list_users to discover account names/ids.',
  {
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of items to return (default 10)'),
    user: z
      .string()
      .optional()
      .describe(
        'Optional Plex account name (e.g. "Feelsgooodjpeg") or numeric account id to scope history to one user. Resolved via /accounts.'
      ),
  },
  safe(async ({ count, user }) => {
    const params: Record<string, string> = {
      sort: 'viewedAt:desc',
      'X-Plex-Container-Start': '0',
      'X-Plex-Container-Size': String(count ?? 10),
    };

    let scopedUser: { id: number; name: string } | null = null;
    if (user !== undefined) {
      scopedUser = await resolveAccountId(user);
      params.accountID = String(scopedUser.id);
    }

    const data = await plexApi<PlexResponse>('/status/sessions/history/all', params);

    const items = (data.MediaContainer.Metadata ?? []).map((m) => formatItem(m, 'viewedAt'));

    const summary = scopedUser
      ? `${plural(items.length, 'recent watch event')} for ${scopedUser.name} (accountID ${scopedUser.id})`
      : `${plural(items.length, 'recent watch event')}`;

    return envelope(summary, items);
  }),
  { annotations: { readOnlyHint: true } }
);
