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
