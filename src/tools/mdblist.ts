import { tool } from './define.js';
import { z } from 'zod';
import { env } from '../env.js';
import {
  fetchMdbBulkItems,
  fetchMdbList,
  mergeProviders as mergeMdbProviders,
  normalizeMdbListMediaType,
  normalizeMdbMediaType,
  type MdbBulkItem,
  type MdbRating,
  type RatingsFilter,
} from '../clients/mdblist/client.js';
import { safe } from './errors.js';
import { envelope, plural } from './output.js';

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
  return normalizeMdbMediaType(value);
}

const mediaTypeSchema = z.preprocess(normalizeMediaType, z.enum(['movie', 'tv']));

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

    const requests: Array<Promise<Array<{ type: 'movie' | 'tv'; data: MdbBulkItem[]; ids: number[] }>>> = [];
    for (const type of ['movie', 'tv'] as const) {
      const ids = grouped[type];
      if (ids.length === 0) continue;
      requests.push(fetchMdbBulkItems({ apiKey: env.MDBLIST_API_KEY, type, ids }));
    }

    const responses = (await Promise.all(requests)).flat();

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
        const providers = mergeMdbProviders(item.streams, item.watch_providers);
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

const listMediaTypeSchema = z.preprocess(
  normalizeMdbListMediaType,
  z.enum(['movie', 'tv', 'all'])
);

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

    const result = await fetchMdbList({
      apiKey: env.MDBLIST_API_KEY,
      list,
      mediaType: mediaType as string | undefined,
      limit,
      offset,
      ratingsFilter: ratingsFilter as RatingsFilter | undefined,
    });

    const summary = result.filterStats
      ? `${result.ref.user}/${result.ref.slug} — ${result.filterStats.passed}/${result.filterStats.input} items pass ratingsFilter (combinator: ${ratingsFilter?.combinator ?? 'any'})`
      : `${result.ref.user}/${result.ref.slug} — ${plural(result.items.length, 'item')} returned ` +
        `(movies: ${result.movieCount}, shows: ${result.showCount}, total: ${result.pagination.total}${result.pagination.hasMore ? ', more available' : ''})`;

    return envelope(summary, result.items, {
      list: result.ref,
      pagination: result.pagination,
      ...(result.filterStats ? { filter: { ...result.filterStats, ...ratingsFilter } } : {}),
    });
  }),
  { annotations: { readOnlyHint: true } }
);
