export interface MdbRating {
  source: string;
  value: number | null;
  score?: number | null;
  votes?: number | null;
  popular?: number | null;
  url?: string | null;
}

export interface MdbProvider {
  id?: number;
  name?: string;
}

export interface MdbBulkItem {
  // MDBList's internal id - NOT the TMDb id. Use `ids.tmdb` for matching.
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

export interface MdbListItem {
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

export interface MdbListResponse {
  movies?: MdbListItem[];
  shows?: MdbListItem[];
  pagination?: {
    limit?: number;
    offset?: number;
    total?: number;
    has_more?: boolean;
  };
}

export interface MdbListRef {
  user: string;
  slug: string;
}

export interface RatingsFilter {
  combinator?: 'any' | 'all';
  minImdb?: number;
  minTomatoes?: number;
  minTomatoesAudience?: number;
  minMetacritic?: number;
  minLetterboxd?: number;
}

export interface ScoredItem {
  imdb: number | null;
  tomatoes: number | null;
  tomatoesaudience: number | null;
  metacritic: number | null;
  letterboxd: number | null;
}

export interface NormalizedListItem {
  title: string | undefined;
  year: number | undefined;
  mediaType: 'movie' | 'tv' | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  releaseDate: string | null;
  runtime: number | null;
  rank: number | null;
}

export interface FetchListResult {
  ref: MdbListRef;
  items: Array<NormalizedListItem & { ratings?: ScoredItem }>;
  baseCount: number;
  movieCount: number;
  showCount: number;
  filterStats: { input: number; passed: number } | null;
  pagination: {
    limit: number | null;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

const BULK_CHUNK_SIZE = 200;

export function normalizeMdbMediaType(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (['show', 'shows', 'series', 'tvshow', 'tvseries'].includes(normalized)) return 'tv';
  if (['movies', 'film', 'films'].includes(normalized)) return 'movie';
  return value;
}

export function normalizeMdbListMediaType(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (['show', 'shows', 'series', 'tv', 'tvshow', 'tvseries'].includes(normalized)) return 'tv';
  if (['movies', 'film', 'films'].includes(normalized)) return 'movie';
  return value;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function parseListRef(input: string): MdbListRef {
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

export function mergeProviders(...lists: (MdbProvider[] | undefined)[]): string[] {
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

export function extractScores(raw: MdbRating[] | undefined): ScoredItem {
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

export function passesRatingsFilter(scores: ScoredItem, filter: RatingsFilter): boolean {
  const checks: boolean[] = [];
  if (filter.minImdb != null) checks.push(scores.imdb != null && scores.imdb >= filter.minImdb);
  if (filter.minTomatoes != null) checks.push(scores.tomatoes != null && scores.tomatoes >= filter.minTomatoes);
  if (filter.minTomatoesAudience != null) {
    checks.push(scores.tomatoesaudience != null && scores.tomatoesaudience >= filter.minTomatoesAudience);
  }
  if (filter.minMetacritic != null) checks.push(scores.metacritic != null && scores.metacritic >= filter.minMetacritic);
  if (filter.minLetterboxd != null) checks.push(scores.letterboxd != null && scores.letterboxd >= filter.minLetterboxd);
  if (checks.length === 0) return true;
  return (filter.combinator ?? 'any') === 'all' ? checks.every(Boolean) : checks.some(Boolean);
}

export async function fetchRatingsByType({
  apiKey,
  type,
  ids,
}: {
  apiKey: string;
  type: 'movie' | 'tv';
  ids: number[];
}): Promise<Map<number, MdbBulkItem>> {
  const byId = new Map<number, MdbBulkItem>();
  for (const batch of chunk(ids, BULK_CHUNK_SIZE)) {
    const url = `https://api.mdblist.com/tmdb/${type === 'tv' ? 'show' : 'movie'}/?apikey=${encodeURIComponent(apiKey)}`;
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

export async function fetchMdbBulkItems({
  apiKey,
  type,
  ids,
}: {
  apiKey: string;
  type: 'movie' | 'tv';
  ids: number[];
}): Promise<Array<{ type: 'movie' | 'tv'; data: MdbBulkItem[]; ids: number[] }>> {
  const responses: Array<{ type: 'movie' | 'tv'; data: MdbBulkItem[]; ids: number[] }> = [];
  for (const batch of chunk(ids, BULK_CHUNK_SIZE)) {
    const url = `https://api.mdblist.com/tmdb/${type === 'tv' ? 'show' : 'movie'}/?apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ids: batch }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `MDBList ${res.status} ${res.statusText} (${type} batch of ${batch.length}): ${body.slice(0, 200)}`
      );
    }
    responses.push({ type, data: (await res.json()) as MdbBulkItem[], ids: batch });
  }
  return responses;
}

function normalizeListFilter(mediaType: string | undefined): 'movie' | 'tv' | 'all' {
  const v = String(mediaType ?? 'all').toLowerCase().replace(/[\s_-]+/g, '');
  if (['show', 'shows', 'series', 'tv', 'tvshow', 'tvseries'].includes(v)) return 'tv';
  if (['movies', 'film', 'films'].includes(v)) return 'movie';
  return v === 'movie' ? 'movie' : v === 'tv' ? 'tv' : 'all';
}

export async function fetchMdbList({
  apiKey,
  list,
  mediaType,
  limit,
  offset,
  ratingsFilter,
}: {
  apiKey: string;
  list: string;
  mediaType?: string;
  limit?: number;
  offset?: number;
  ratingsFilter?: RatingsFilter;
}): Promise<FetchListResult> {
  const ref = parseListRef(list);
  const url = new URL(
    `https://api.mdblist.com/lists/${encodeURIComponent(ref.user)}/${encodeURIComponent(ref.slug)}/items`
  );
  url.searchParams.set('apikey', apiKey);
  if (limit != null) url.searchParams.set('limit', String(limit));
  if (offset != null) url.searchParams.set('offset', String(offset));

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `MDBList ${res.status} ${res.statusText} for ${ref.user}/${ref.slug}: ${body.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as MdbListResponse;
  const normalizedFilter = normalizeListFilter(mediaType);
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

  let items: Array<NormalizedListItem & { ratings?: ScoredItem }> = baseItems;
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
      movieIds.length ? fetchRatingsByType({ apiKey, type: 'movie', ids: movieIds }) : Promise.resolve(new Map<number, MdbBulkItem>()),
      tvIds.length ? fetchRatingsByType({ apiKey, type: 'tv', ids: tvIds }) : Promise.resolve(new Map<number, MdbBulkItem>()),
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
      .filter((v): v is NormalizedListItem & { ratings: ScoredItem } => v != null);

    filterStats = { input: baseItems.length, passed: scored.length };
    items = scored;
  }

  const total = data.pagination?.total ?? baseItems.length;
  return {
    ref,
    items,
    baseCount: baseItems.length,
    movieCount: (data.movies ?? []).length,
    showCount: (data.shows ?? []).length,
    filterStats,
    pagination: {
      limit: data.pagination?.limit ?? null,
      offset: data.pagination?.offset ?? 0,
      total,
      hasMore: data.pagination?.has_more ?? false,
    },
  };
}
