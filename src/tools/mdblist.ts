import { tool } from './define.js';
import { z } from 'zod';
import { env } from '../env.js';
import { safe } from './errors.js';
import { envelope, plural } from './output.js';

interface MdbRating {
  source: string;
  value: number | null;
  score?: number | null;
  votes?: number | null;
  popular?: number | null;
  url?: string | null;
}

interface MdbProvider {
  id?: number;
  name?: string;
}

interface MdbBulkItem {
  // MDBList's internal id — NOT the TMDb id. Use `ids.tmdb` for matching.
  id?: number;
  ids?: {
    imdb?: string | null;
    tmdb?: number | null;
    tvdb?: number | null;
    trakt?: number | null;
    mal?: number | null;
    mdblist?: string | null;
  };
  imdb_id?: string;
  imdbid?: string;
  title?: string;
  year?: number;
  type?: string;
  ratings?: MdbRating[];
  streams?: MdbProvider[];
  watch_providers?: MdbProvider[];
}

const BULK_CHUNK_SIZE = 200;

const SOURCE_LABELS: Record<string, string> = {
  imdb: 'IMDb',
  tomatoes: 'Rotten Tomatoes (critics)',
  tomatoesaudience: 'Rotten Tomatoes (audience)',
  metacritic: 'Metacritic',
  letterboxd: 'Letterboxd',
  trakt: 'Trakt',
  tmdb: 'TMDb',
  rogerebert: 'Roger Ebert',
};

function normalizeMediaType(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (['show', 'shows', 'series', 'tvshow', 'tvseries'].includes(normalized)) return 'tv';
  if (['movies', 'film', 'films'].includes(normalized)) return 'movie';
  return value;
}

const mediaTypeSchema = z.preprocess(normalizeMediaType, z.enum(['movie', 'tv']));

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function mergeProviders(...lists: (MdbProvider[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const p of list ?? []) {
      const name = p.name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

function mapRatings(raw: MdbRating[] | undefined) {
  return (raw ?? [])
    .filter((r) => r.value !== null && r.value !== undefined)
    .map((r) => ({
      source: SOURCE_LABELS[r.source] ?? r.source,
      score: r.value,
      ...(r.votes ? { votes: r.votes } : {}),
    }));
}

export const mdblist_ratings = tool(
  'mdblist_ratings',
  'Fetch aggregated ratings (Rotten Tomatoes, IMDb, Metacritic, Letterboxd, etc.) plus a quick streamingProviders hint for one or many titles in a single batched call (one request per media_type). The streaming hint is global and undifferentiated (no flatrate/rent/buy split, no region selection); for region-specific or detailed availability call overseerr_watch_providers for that one title. Pass a single-element list for one title.',
  {
    items: z
      .array(
        z.object({
          tmdbId: z.number().int().describe('TMDb ID of the title'),
          mediaType: mediaTypeSchema.describe('movie or tv'),
        })
      )
      .min(1)
      .describe('Titles to fetch. Mixed movies and TV are fine — grouped internally.'),
  },
  safe(async ({ items }) => {
    if (!env.MDBLIST_API_KEY) {
      return {
        content: [{ type: 'text', text: 'MDBLIST_API_KEY is not configured.' }],
      };
    }

    const grouped: Record<'movie' | 'tv', number[]> = { movie: [], tv: [] };
    for (const item of items) {
      const type = normalizeMediaType(item.mediaType) as 'movie' | 'tv';
      grouped[type].push(item.tmdbId);
    }

    const requests: Array<Promise<{ type: 'movie' | 'tv'; data: MdbBulkItem[]; ids: number[] }>> = [];
    for (const type of ['movie', 'tv'] as const) {
      const ids = grouped[type];
      if (ids.length === 0) continue;
      for (const batch of chunk(ids, BULK_CHUNK_SIZE)) {
        const url = `https://api.mdblist.com/tmdb/${type === 'tv' ? 'show' : 'movie'}/?apikey=${encodeURIComponent(env.MDBLIST_API_KEY)}`;
        requests.push(
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ ids: batch }),
          }).then(async (res) => {
            if (!res.ok) {
              const body = await res.text().catch(() => '');
              throw new Error(
                `MDBList ${res.status} ${res.statusText} (${type} batch of ${batch.length}): ${body.slice(0, 200)}`
              );
            }
            const data = (await res.json()) as MdbBulkItem[];
            return { type, data, ids: batch };
          })
        );
      }
    }

    const responses = await Promise.all(requests);

    const results: Array<{
      tmdbId: number;
      mediaType: 'movie' | 'tv';
      title?: string;
      year?: number;
      imdbId?: string | null;
      ratings: ReturnType<typeof mapRatings>;
      streamingProviders?: string[];
    }> = [];
    const seenByType: Record<'movie' | 'tv', Set<number>> = { movie: new Set(), tv: new Set() };

    for (const { type, data, ids } of responses) {
      const byId = new Map<number, MdbBulkItem>();
      for (const item of data ?? []) {
        const tmdb = item.ids?.tmdb ?? item.id;
        if (typeof tmdb === 'number') byId.set(tmdb, item);
      }
      for (const id of ids) {
        const item = byId.get(id);
        if (!item) continue;
        seenByType[type].add(id);
        const providers = mergeProviders(item.streams, item.watch_providers);
        results.push({
          tmdbId: id,
          mediaType: type,
          title: item.title,
          year: item.year,
          imdbId: item.ids?.imdb ?? item.imdb_id ?? item.imdbid,
          ratings: mapRatings(item.ratings),
          ...(providers.length ? { streamingProviders: providers } : {}),
        });
      }
    }

    const missing = items.filter((item) => {
      const type = normalizeMediaType(item.mediaType) as 'movie' | 'tv';
      return !seenByType[type].has(item.tmdbId);
    });

    const summary = `${plural(results.length, 'title')} with ratings${missing.length ? `, ${missing.length} missing` : ''} (${requests.length} request${requests.length === 1 ? '' : 's'})`;

    return envelope(summary, results, missing.length ? { missing } : undefined);
  }),
  { annotations: { readOnlyHint: true } }
);

interface MdbListItem {
  id?: number;
  mediatype?: string;
  imdb_id?: string | null;
  tvdb_id?: number | null;
  ids?: {
    imdb?: string | null;
    tmdb?: number | null;
    tvdb?: number | null;
    mdblist?: string | null;
  };
  title?: string;
  release_year?: number;
  release_date?: string | null;
  runtime?: number | null;
  rank?: number;
}

interface MdbListResponse {
  movies?: MdbListItem[];
  shows?: MdbListItem[];
  pagination?: {
    limit?: number;
    offset?: number;
    total?: number;
    has_more?: boolean;
  };
}

const listMediaTypeSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const v = value.toLowerCase().replace(/[\s_-]+/g, '');
    if (['show', 'shows', 'series', 'tv', 'tvshow', 'tvseries'].includes(v)) return 'tv';
    if (['movies', 'film', 'films'].includes(v)) return 'movie';
    return value;
  },
  z.enum(['movie', 'tv', 'all'])
);

// Accepts a full mdblist.com URL or a "user/slug" shorthand and returns the
// pair the API expects. The list page URL embeds the same two segments after
// /lists/, so we just look for that pattern.
function parseListRef(input: string): { user: string; slug: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('list is required (URL or "user/slug")');

  const urlMatch = trimmed.match(/\/lists\/([^/?#]+)\/([^/?#]+)/i);
  if (urlMatch) return { user: urlMatch[1], slug: urlMatch[2] };

  const shorthand = trimmed.replace(/^\/+|\/+$/g, '').split('/');
  if (shorthand.length === 2 && shorthand[0] && shorthand[1]) {
    return { user: shorthand[0], slug: shorthand[1] };
  }

  throw new Error(
    `Could not parse list reference: ${input}. Expected an mdblist.com URL or "user/slug" shorthand.`
  );
}

// Score thresholds shared between the list filter and any future filtered
// readers. Missing scores never pass — there's no "unknown counts as pass".
const ratingsFilterSchema = z
  .object({
    combinator: z
      .enum(['any', 'all'])
      .optional()
      .describe('"any" returns titles passing AT LEAST ONE threshold; "all" requires every set threshold. Default "any".'),
    minImdb: z.number().min(0).max(10).optional().describe('Minimum IMDb score (0–10).'),
    minTomatoes: z.number().min(0).max(100).optional().describe('Minimum Rotten Tomatoes critic score (0–100).'),
    minTomatoesAudience: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Minimum Rotten Tomatoes audience score (0–100). NOTE: MDBList rarely returns audience scores; items without one will not pass this threshold.'),
    minMetacritic: z.number().min(0).max(100).optional().describe('Minimum Metacritic score (0–100).'),
    minLetterboxd: z.number().min(0).max(10).optional().describe('Minimum Letterboxd score (0–10).'),
  })
  .refine(
    (v) =>
      v.minImdb != null ||
      v.minTomatoes != null ||
      v.minTomatoesAudience != null ||
      v.minMetacritic != null ||
      v.minLetterboxd != null,
    { message: 'ratingsFilter needs at least one threshold (minImdb / minTomatoes / minTomatoesAudience / minMetacritic / minLetterboxd).' }
  );

interface ScoredItem {
  imdb: number | null;
  tomatoes: number | null;
  tomatoesaudience: number | null;
  metacritic: number | null;
  letterboxd: number | null;
}

function extractScores(raw: MdbRating[] | undefined): ScoredItem {
  const out: ScoredItem = {
    imdb: null,
    tomatoes: null,
    tomatoesaudience: null,
    metacritic: null,
    letterboxd: null,
  };
  for (const r of raw ?? []) {
    if (r.value == null) continue;
    if (r.source === 'imdb') out.imdb = r.value;
    else if (r.source === 'tomatoes') out.tomatoes = r.value;
    else if (r.source === 'tomatoesaudience') out.tomatoesaudience = r.value;
    else if (r.source === 'metacritic') out.metacritic = r.value;
    else if (r.source === 'letterboxd') out.letterboxd = r.value;
  }
  return out;
}

function passesRatingsFilter(scores: ScoredItem, filter: z.infer<typeof ratingsFilterSchema>): boolean {
  const checks: boolean[] = [];
  // For each set threshold, a present score must exceed it. A null score never passes.
  if (filter.minImdb != null) checks.push(scores.imdb != null && scores.imdb >= filter.minImdb);
  if (filter.minTomatoes != null) checks.push(scores.tomatoes != null && scores.tomatoes >= filter.minTomatoes);
  if (filter.minTomatoesAudience != null) checks.push(scores.tomatoesaudience != null && scores.tomatoesaudience >= filter.minTomatoesAudience);
  if (filter.minMetacritic != null) checks.push(scores.metacritic != null && scores.metacritic >= filter.minMetacritic);
  if (filter.minLetterboxd != null) checks.push(scores.letterboxd != null && scores.letterboxd >= filter.minLetterboxd);
  if (checks.length === 0) return true; // schema requires ≥1, but be defensive
  return (filter.combinator ?? 'any') === 'all' ? checks.every(Boolean) : checks.some(Boolean);
}

async function fetchRatingsByType(type: 'movie' | 'tv', ids: number[]): Promise<Map<number, MdbBulkItem>> {
  const byId = new Map<number, MdbBulkItem>();
  for (const batch of chunk(ids, BULK_CHUNK_SIZE)) {
    const url = `https://api.mdblist.com/tmdb/${type === 'tv' ? 'show' : 'movie'}/?apikey=${encodeURIComponent(env.MDBLIST_API_KEY ?? '')}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ids: batch }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MDBList ${res.status} ${res.statusText} (${type} ratings batch): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as MdbBulkItem[];
    for (const item of data ?? []) {
      const id = item.ids?.tmdb ?? item.id;
      if (typeof id === 'number') byId.set(id, item);
    }
  }
  return byId;
}

export const mdblist_list = tool(
  'mdblist_list',
  'Fetch a public mdblist.com list, optionally filtering by rating thresholds in the same call. Accepts a full list URL or the "user/slug" shorthand. Pass `ratingsFilter` to combine list-fetch + ratings-fetch + filter in one request — this is the right shape for "what passes IMDb > 7 OR RT critic > 65 on this list" since it avoids returning hundreds of items just to filter them later. Returns title, year, IMDb/TMDb/TVDb ids, mediaType, releaseDate, runtime, rank; when filtered, also returns scores inline.',
  {
    list: z
      .string()
      .min(1)
      .describe(
        'List reference — either a full mdblist.com URL like "https://mdblist.com/lists/hdlists/latest-hd-horror-movies-top-rated-from-1980-to-today" or the "user/slug" shorthand.'
      ),
    mediaType: listMediaTypeSchema
      .optional()
      .describe('Filter results to one media type. Defaults to "all".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe('Max items to return per page. Defaults to 1000 (the MDBList API default).'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Offset for pagination. Defaults to 0.'),
    ratingsFilter: ratingsFilterSchema
      .optional()
      .describe('Optional rating thresholds. When set, the tool also fetches ratings for every list item and returns only those passing the filter, with scores inline. Use this to keep tool output small — without a filter, large lists (hundreds of items) can blow the context budget.'),
  },
  safe(async ({ list, mediaType, limit, offset, ratingsFilter }) => {
    if (!env.MDBLIST_API_KEY) {
      throw new Error('MDBLIST_API_KEY must be set in .env to use mdblist_list.');
    }

    const { user, slug } = parseListRef(list);
    const url = new URL(
      `https://api.mdblist.com/lists/${encodeURIComponent(user)}/${encodeURIComponent(slug)}/items`
    );
    url.searchParams.set('apikey', env.MDBLIST_API_KEY);
    if (limit != null) url.searchParams.set('limit', String(limit));
    if (offset != null) url.searchParams.set('offset', String(offset));

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `MDBList ${res.status} ${res.statusText} for ${user}/${slug}: ${body.slice(0, 200)}`
      );
    }

    const data = (await res.json()) as MdbListResponse;
    // Re-normalize in the handler — the Zod preprocess covers the SDK path but
    // direct handler invocations (tests, internal callers) skip it.
    const rawFilter = (mediaType ?? 'all') as string;
    const normalizedFilter = (() => {
      const v = rawFilter.toLowerCase().replace(/[\s_-]+/g, '');
      if (['show', 'shows', 'series', 'tv', 'tvshow', 'tvseries'].includes(v)) return 'tv';
      if (['movies', 'film', 'films'].includes(v)) return 'movie';
      return v === 'movie' ? 'movie' : v === 'tv' ? 'tv' : 'all';
    })();
    const raw: MdbListItem[] = [
      ...(normalizedFilter === 'tv' ? [] : (data.movies ?? [])),
      ...(normalizedFilter === 'movie' ? [] : (data.shows ?? [])),
    ];

    const baseItems = raw.map((item) => ({
      title: item.title,
      year: item.release_year,
      mediaType: (item.mediatype === 'show' ? 'tv' : (item.mediatype ?? null)) as 'movie' | 'tv' | null,
      imdbId: item.ids?.imdb ?? item.imdb_id ?? null,
      tmdbId: item.ids?.tmdb ?? item.id ?? null,
      tvdbId: item.ids?.tvdb ?? item.tvdb_id ?? null,
      releaseDate: item.release_date ?? null,
      runtime: item.runtime ?? null,
      rank: item.rank ?? null,
    }));

    let items: (typeof baseItems[number] & { ratings?: ScoredItem })[] = baseItems;
    let filterStats: { input: number; passed: number } | null = null;

    if (ratingsFilter) {
      const movieIds: number[] = [];
      const tvIds: number[] = [];
      for (const item of baseItems) {
        if (item.tmdbId == null) continue;
        if (item.mediaType === 'tv') tvIds.push(item.tmdbId);
        else movieIds.push(item.tmdbId);
      }

      const [movieRatings, tvRatings] = await Promise.all([
        movieIds.length ? fetchRatingsByType('movie', movieIds) : Promise.resolve(new Map<number, MdbBulkItem>()),
        tvIds.length ? fetchRatingsByType('tv', tvIds) : Promise.resolve(new Map<number, MdbBulkItem>()),
      ]);

      const scored = baseItems
        .map((item) => {
          if (item.tmdbId == null) return null;
          const ratingsItem = (item.mediaType === 'tv' ? tvRatings : movieRatings).get(item.tmdbId);
          const scores = extractScores(ratingsItem?.ratings);
          return passesRatingsFilter(scores, ratingsFilter)
            ? { ...item, ratings: scores }
            : null;
        })
        .filter((v): v is typeof baseItems[number] & { ratings: ScoredItem } => v != null);

      filterStats = { input: baseItems.length, passed: scored.length };
      items = scored;
    }

    const total = data.pagination?.total ?? baseItems.length;
    const hasMore = data.pagination?.has_more ?? false;
    const movieCount = (data.movies ?? []).length;
    const showCount = (data.shows ?? []).length;
    const summary = filterStats
      ? `${user}/${slug} — ${filterStats.passed}/${filterStats.input} items pass ratingsFilter (combinator: ${ratingsFilter?.combinator ?? 'any'})`
      : `${user}/${slug} — ${plural(items.length, 'item')} returned ` +
        `(movies: ${movieCount}, shows: ${showCount}, total: ${total}${hasMore ? ', more available' : ''})`;

    return envelope(summary, items, {
      list: { user, slug },
      pagination: {
        limit: data.pagination?.limit ?? null,
        offset: data.pagination?.offset ?? 0,
        total,
        hasMore,
      },
      ...(filterStats ? { filter: { ...filterStats, ...ratingsFilter } } : {}),
    });
  }),
  { annotations: { readOnlyHint: true } }
);
