import { tool } from './define.js';
import { z } from 'zod';
import { env } from '../env.js';
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
  parentIndex?: number;
  index?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  librarySectionID?: number;
  guid?: string;
}

interface PlexResponse {
  MediaContainer: {
    size?: number;
    Metadata?: PlexMetadata[];
  };
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

    const sections = await listSections();
    const wanted = sections.filter((s) => {
      if (sectionFilter === 'all') return s.type === 'movie' || s.type === 'show';
      if (sectionFilter === 'movies') return s.type === 'movie';
      return s.type === 'show';
    });

    if (wanted.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ items: [], note: `No ${sectionFilter} sections found.` }, null, 2),
          },
        ],
      };
    }

    const responses = await Promise.all(
      wanted.map((sec) =>
        plexApi<PlexResponse>(`/library/sections/${sec.key}/unwatched`, {
          sort: sortParam,
          'X-Plex-Container-Start': '0',
          'X-Plex-Container-Size': String(limit),
        })
      )
    );
    const collected: PlexMetadata[] = responses.flatMap((data) => data.MediaContainer.Metadata ?? []);

    // Re-sort the merged list when we queried multiple sections (Plex sorts within each).
    if (wanted.length > 1 && sortMode !== 'random') {
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

export const plex_watch_history = tool(
  'plex_watch_history',
  'Show recently watched movies and TV episodes from Plex play history, newest first.',
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
    const data = await plexApi<PlexResponse>('/status/sessions/history/all', {
      sort: 'viewedAt:desc',
      'X-Plex-Container-Start': '0',
      'X-Plex-Container-Size': String(count ?? 10),
    });

    const items = (data.MediaContainer.Metadata ?? []).map((m) => formatItem(m, 'viewedAt'));

    return envelope(`${plural(items.length, 'recent watch event')}`, items);
  }),
  { annotations: { readOnlyHint: true } }
);
