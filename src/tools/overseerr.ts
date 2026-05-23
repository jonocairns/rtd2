import { tool } from './define.js';
import { z } from 'zod';
import { env } from '../env.js';
import { getStoredMediaTitle, storeMediaTitle, type MediaTitle } from '../db.js';
import { safe } from './errors.js';
import { hashString, once } from './idempotency.js';
import { envelope, plural } from './output.js';

// Overseerr uses the double-submit cookie CSRF pattern: a GET to any
// authenticated endpoint sets _csrf (HttpOnly) + XSRF-TOKEN (readable).
// Write requests must echo the XSRF-TOKEN value as X-XSRF-Token and send
// both cookies. Fetch doesn't manage cookies automatically, so we do it here.
async function fetchCsrfTokens(): Promise<{ cookieHeader: string; xsrfToken: string }> {
  const res = await fetch(`${env.OVERSEERR_URL}/api/v1/auth/me`, {
    headers: {
      'X-Api-Key': env.OVERSEERR_API_KEY,
      Accept: 'application/json',
    },
  });

  const cookies = res.headers.getSetCookie?.() ?? [];
  let csrfCookie = '';
  let xsrfCookie = '';
  let xsrfToken = '';

  for (const raw of cookies) {
    const [pair] = raw.split(';');
    const [name, value] = pair.split('=');
    if (name?.trim() === '_csrf') csrfCookie = `_csrf=${value}`;
    if (name?.trim() === 'XSRF-TOKEN') {
      xsrfCookie = `XSRF-TOKEN=${value}`;
      xsrfToken = decodeURIComponent(value ?? '');
    }
  }

  return {
    cookieHeader: [csrfCookie, xsrfCookie].filter(Boolean).join('; '),
    xsrfToken,
  };
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';

  const extraHeaders: Record<string, string> = {};
  if (isWrite) {
    const { cookieHeader, xsrfToken } = await fetchCsrfTokens();
    extraHeaders['Cookie'] = cookieHeader;
    extraHeaders['X-XSRF-Token'] = xsrfToken;
  }

  const url = `${env.OVERSEERR_URL}/api/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'X-Api-Key': env.OVERSEERR_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extraHeaders,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Overseerr ${res.status} ${res.statusText} at ${path}: ${body.slice(0, 500)}`
    );
  }
  return res.json() as Promise<T>;
}

export async function validateConnection(): Promise<void> {
  await api('/status');
}

const statusMap: Record<number, string> = {
  1: 'unknown',
  2: 'pending',
  3: 'processing',
  4: 'partially available',
  5: 'available',
};

function normalizeMediaType(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (['show', 'shows', 'series', 'tvshow', 'tvseries'].includes(normalized)) return 'tv';
  if (['movies', 'film', 'films'].includes(normalized)) return 'movie';
  return value;
}

function normalizeIssueType(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (['subtitles', 'caption', 'captions', 'cc'].includes(normalized)) return 'subtitle';
  return value;
}

function normalizeCreditRole(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (['director', 'directors', 'directed'].includes(normalized)) return 'directing';
  if (['writer', 'writers', 'written'].includes(normalized)) return 'writing';
  if (['actor', 'actors', 'actress', 'actresses', 'cast'].includes(normalized)) return 'acting';
  if (['everything', 'any'].includes(normalized)) return 'all';
  return value;
}

const mediaTypeSchema = z.preprocess(normalizeMediaType, z.enum(['movie', 'tv']));

interface SearchResult {
  id: number;
  mediaType: 'movie' | 'tv' | 'person';
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  mediaInfo?: { id?: number; status?: number };
}

export const overseerr_search = tool(
  'overseerr_search',
  'Search Overseerr/Seerr for a movie or TV show by name. Returns up to 5 matches with TMDb id, media type, release year, and library status (available / partially available / pending / processing / unknown / missing).',
  {
    query: z.string().describe('Title to search for'),
    year: z.number().int().optional().describe('Release year (optional, helps disambiguate sequels and remakes)'),
  },
  safe(async ({ query, year }) => {
    // URLSearchParams encodes spaces as '+' but Overseerr requires '%20'.
    let qs = `query=${encodeURIComponent(query)}`;
    if (year) qs += `&year=${year}`;
    const data = await api<{ results: SearchResult[] }>(`/search?${qs}`);

    const hits = data.results
      .filter((r) => r.mediaType === 'movie' || r.mediaType === 'tv')
      .slice(0, 5)
      .map((r) => ({
        tmdbId: r.id,
        mediaType: r.mediaType,
        title: r.title ?? r.name ?? '(unknown)',
        year: (r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4) || null,
        libraryStatus: r.mediaInfo?.status
          ? statusMap[r.mediaInfo.status] ?? 'unknown'
          : 'missing',
      }));

    return envelope(`${plural(hits.length, 'match', 'matches')} for "${query}"`, hits);
  }),
  { annotations: { readOnlyHint: true } }
);

export const overseerr_get_quota = tool(
  'overseerr_get_quota',
  "Get the current user's Overseerr request quota: how many movie/TV requests remain in this period.",
  {},
  safe(async () => {
    const data = await api('/user/quota');
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }),
  { annotations: { readOnlyHint: true } }
);

const requestStatusMap: Record<number, string> = {
  1: 'pending approval',
  2: 'approved',
  3: 'declined',
};

interface OverseerrRequest {
  id: number;
  status: number;
  createdAt: string;
  updatedAt: string;
  type: 'movie' | 'tv';
  is4k: boolean;
  media: {
    tmdbId: number;
    status: number;
    mediaType: 'movie' | 'tv';
    title?: string;
    name?: string;
    releaseDate?: string;
    firstAirDate?: string;
  };
  seasons?: { id: number; seasonNumber: number; status: number }[];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function titleFromRequest(request: OverseerrRequest): MediaTitle | null {
  const title = request.media.title ?? request.media.name;
  if (!title) return null;
  return {
    mediaType: request.type,
    tmdbId: request.media.tmdbId,
    title,
    year: (request.media.releaseDate ?? request.media.firstAirDate ?? '').slice(0, 4) || null,
  };
}

async function fetchMediaTitle(
  mediaType: 'movie' | 'tv',
  tmdbId: number
): Promise<MediaTitle | null> {
  const stored = getStoredMediaTitle(mediaType, tmdbId);
  if (stored) return stored;

  try {
    const detail = await api<MediaDetailFull>(`/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}`);
    const title = detail.title ?? detail.name;
    if (!title) return null;
    const mediaTitle = {
      mediaType,
      tmdbId,
      title,
      year: (detail.releaseDate ?? detail.firstAirDate ?? '').slice(0, 4) || null,
    };
    storeMediaTitle(mediaTitle);
    return mediaTitle;
  } catch {
    return null;
  }
}

async function enrichRequestTitles(requests: OverseerrRequest[]): Promise<Map<string, MediaTitle>> {
  const titles = new Map<string, MediaTitle>();
  const missing = new Map<string, { mediaType: 'movie' | 'tv'; tmdbId: number }>();

  for (const request of requests) {
    const key = `${request.type}:${request.media.tmdbId}`;
    const embedded = titleFromRequest(request);
    if (embedded) {
      storeMediaTitle(embedded);
      titles.set(key, embedded);
      continue;
    }

    const stored = getStoredMediaTitle(request.type, request.media.tmdbId);
    if (stored) {
      titles.set(key, stored);
    } else {
      missing.set(key, { mediaType: request.type, tmdbId: request.media.tmdbId });
    }
  }

  const fetched = await mapWithConcurrency([...missing.values()], 5, (item) =>
    fetchMediaTitle(item.mediaType, item.tmdbId)
  );
  for (const title of fetched) {
    if (title) titles.set(`${title.mediaType}:${title.tmdbId}`, title);
  }

  return titles;
}

export const overseerr_list_requests = tool(
  'overseerr_list_requests',
  'List Overseerr requests. Optional filters: status (all/pending/approved/declined/available/unavailable/processing), take (max results, default 20).',
  {
    status: z
      .enum(['all', 'pending', 'approved', 'declined', 'available', 'unavailable', 'processing'])
      .optional()
      .describe('Filter by request status. Use all or omit to list all requests.'),
    take: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
  },
  safe(async ({ status, take }) => {
    const params = new URLSearchParams();
    params.set('take', String(take ?? 20));
    if (status && status !== 'all') params.set('filter', status);
    const data = await api<{ results: OverseerrRequest[] }>(`/request?${params.toString()}`);
    const titles = await enrichRequestTitles(data.results);

    const items = data.results.map((r) => {
      const title = titles.get(`${r.type}:${r.media.tmdbId}`);
      return {
        id: r.id,
        tmdbId: r.media.tmdbId,
        type: r.type,
        title: title?.title ?? null,
        year: title?.year ?? null,
        requestStatus: requestStatusMap[r.status] ?? 'unknown',
        mediaStatus: statusMap[r.media.status] ?? 'unknown',
        is4k: r.is4k,
        createdAt: r.createdAt,
        seasons: r.seasons?.map((s) => ({ n: s.seasonNumber, status: statusMap[s.status] })) ?? null,
      };
    });

    return envelope(
      `${plural(items.length, 'request')}${status && status !== 'all' ? ` (filter: ${status})` : ''}`,
      items
    );
  }),
  { annotations: { readOnlyHint: true } }
);

export const overseerr_get_request = tool(
  'overseerr_get_request',
  'Get a single Overseerr request by ID, including download status if available.',
  {
    id: z.number().int().describe('The Overseerr request ID'),
  },
  safe(async ({ id }) => {
    const data = await api<OverseerrRequest>(`/request/${id}`);
    const title = (await enrichRequestTitles([data])).get(`${data.type}:${data.media.tmdbId}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...data,
              title: title?.title ?? null,
              year: title?.year ?? null,
            },
            null,
            2
          ),
        },
      ],
    };
  }),
  { annotations: { readOnlyHint: true } }
);

export async function resolveRequestAction(input: {
  id: number;
  action?: 'approve' | 'reject' | 'delete';
}): Promise<string[]> {
  const data = await api<OverseerrRequest>(`/request/${input.id}`);
  const mediaTitle = (await enrichRequestTitles([data])).get(`${data.type}:${data.media.tmdbId}`);
  const title = mediaTitle ? `${mediaTitle.title}${mediaTitle.year ? ` (${mediaTitle.year})` : ''}` : `TMDb ${data.media.tmdbId}`;
  const action = input.action ?? 'update';
  return [
    `${action[0].toUpperCase()}${action.slice(1)} Overseerr request:`,
    `  Request ID: ${data.id}`,
    `  Title: ${title} (${data.type})`,
    `  Request status: ${requestStatusMap[data.status] ?? 'unknown'}`,
    `  Media status: ${statusMap[data.media.status] ?? 'unknown'}`,
    `  Seasons: ${data.seasons?.map((s) => s.seasonNumber).join(', ') || 'n/a'}`,
  ];
}

export const overseerr_recommend = tool(
  'overseerr_recommend',
  "Get TMDB-based recommendations for a movie or TV show. Returns up to 6 similar titles with their library status. Call overseerr_search first to get the tmdbId if you don't have it.",
  {
    tmdbId: z.number().int().describe('TMDb ID of the title to base recommendations on'),
    mediaType: mediaTypeSchema.describe('movie or tv'),
  },
  safe(async ({ tmdbId, mediaType }) => {
    const type = normalizeMediaType(mediaType) as 'movie' | 'tv';
    const data = await api<{ results: SearchResult[] }>(
      `/${type}/${tmdbId}/recommendations`
    );

    const hits = (data.results ?? [])
      .filter((r) => r.mediaType === 'movie' || r.mediaType === 'tv')
      .slice(0, 6)
      .map((r) => ({
        tmdbId: r.id,
        mediaType: r.mediaType,
        title: r.title ?? r.name ?? '(unknown)',
        year: (r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4) || null,
        libraryStatus: r.mediaInfo?.status
          ? (statusMap[r.mediaInfo.status] ?? 'unknown')
          : 'missing',
      }));

    const missing = hits.filter((h) => h.libraryStatus === 'missing').length;
    return envelope(
      `${plural(hits.length, 'recommendation')} (${missing} not in library)`,
      hits
    );
  }),
  { annotations: { readOnlyHint: true } }
);

export const overseerr_cancel_request = tool(
  'overseerr_cancel_request',
  'Cancel (delete) an Overseerr request by request ID. Use overseerr_list_requests to find the ID first. This is a mutating operation.',
  {
    id: z.number().int().describe('The Overseerr request ID to cancel'),
  },
  safe(async ({ id }) =>
    once(`overseerr_delete_request:${id}`, async () => {
      const data = await api(`/request/${id}`, { method: 'DELETE' });
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    })
  ),
  { annotations: { readOnlyHint: false } }
);

export const overseerr_delete_request = tool(
  'overseerr_delete_request',
  'Delete an Overseerr request by request ID. Use overseerr_list_requests to find the ID first. This is a mutating operation.',
  {
    id: z.number().int().describe('The Overseerr request ID to delete'),
  },
  safe(async ({ id }) =>
    once(`overseerr_delete_request:${id}`, async () => {
      const data = await api(`/request/${id}`, { method: 'DELETE' });
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    })
  ),
  { annotations: { readOnlyHint: false } }
);

export const overseerr_approve_request = tool(
  'overseerr_approve_request',
  'Approve a pending Overseerr request by request ID. Use overseerr_list_requests to find the ID first. This is a mutating operation.',
  {
    id: z.number().int().describe('The Overseerr request ID to approve'),
  },
  safe(async ({ id }) =>
    once(`overseerr_approve_request:${id}`, async () => {
      const data = await api(`/request/${id}/approve`, { method: 'POST' });
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    })
  ),
  { annotations: { readOnlyHint: false } }
);

export const overseerr_reject_request = tool(
  'overseerr_reject_request',
  'Reject/decline a pending Overseerr request by request ID. Use overseerr_list_requests to find the ID first. This is a mutating operation.',
  {
    id: z.number().int().describe('The Overseerr request ID to reject'),
  },
  safe(async ({ id }) =>
    once(`overseerr_reject_request:${id}`, async () => {
      const data = await api(`/request/${id}/decline`, { method: 'POST' });
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    })
  ),
  { annotations: { readOnlyHint: false } }
);

export const overseerr_trending = tool(
  'overseerr_trending',
  'Get trending/popular movies or TV shows from Overseerr discover. Returns up to 10 results with library status.',
  {
    mediaType: mediaTypeSchema.describe('movie or tv'),
  },
  safe(async ({ mediaType }) => {
    const type = normalizeMediaType(mediaType) as 'movie' | 'tv';
    const data = await api<{ results: SearchResult[] }>(
      type === 'movie' ? '/discover/movies' : '/discover/tv'
    );

    const hits = (data.results ?? []).slice(0, 10).map((r) => ({
      tmdbId: r.id,
      mediaType: r.mediaType,
      title: r.title ?? r.name ?? '(unknown)',
      year: (r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4) || null,
      libraryStatus: r.mediaInfo?.status
        ? (statusMap[r.mediaInfo.status] ?? 'unknown')
        : 'missing',
    }));

    const missing = hits.filter((h) => h.libraryStatus === 'missing').length;
    return envelope(
      `${plural(hits.length, 'trending title')} (${missing} not in library)`,
      hits
    );
  }),
  { annotations: { readOnlyHint: true } }
);

const movieGenres: Record<string, number> = {
  action: 28,
  adventure: 12,
  animation: 16,
  animated: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  fantasy: 14,
  history: 36,
  historical: 36,
  horror: 27,
  music: 10402,
  mystery: 9648,
  romance: 10749,
  'rom-com': 10749,
  romcom: 10749,
  scifi: 878,
  'sci-fi': 878,
  sciencefiction: 878,
  'science-fiction': 878,
  thriller: 53,
  war: 10752,
  western: 37,
};

const tvGenres: Record<string, number> = {
  action: 10759,
  adventure: 10759,
  animation: 16,
  animated: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  kids: 10762,
  mystery: 9648,
  news: 10763,
  reality: 10764,
  romance: 10749,
  scifi: 10765,
  'sci-fi': 10765,
  fantasy: 10765,
  soap: 10766,
  talk: 10767,
  war: 10768,
  politics: 10768,
  western: 37,
};

function normalizeGenre(genre: string): string {
  return genre.toLowerCase().replace(/[\s_]+/g, '-').replace(/&/g, 'and');
}

function genreIdFor(mediaType: 'movie' | 'tv', genre: string): number {
  const normalized = normalizeGenre(genre);
  const compact = normalized.replace(/-/g, '');
  const genres = mediaType === 'movie' ? movieGenres : tvGenres;
  const id = genres[normalized] ?? genres[compact];
  if (!id) {
    throw new Error(
      `Unknown ${mediaType} genre "${genre}". Try one of: ${Object.keys(genres)
        .sort()
        .join(', ')}.`
    );
  }
  return id;
}

export const overseerr_discover = tool(
  'overseerr_discover',
  'Discover popular movies or TV shows by genre with library status. Use this for bare genre prompts like "horror", "sci-fi", "comedy", or "thriller".',
  {
    mediaType: mediaTypeSchema.optional().describe('movie or tv (default movie)'),
    genre: z.string().min(1).describe('Genre name, e.g. horror, sci-fi, comedy, thriller'),
    take: z.number().int().min(1).max(20).optional().describe('Max results (default 10)'),
  },
  safe(async ({ mediaType, genre, take }) => {
    const type = (normalizeMediaType(mediaType) as 'movie' | 'tv' | undefined) ?? 'movie';
    const genreId = genreIdFor(type, genre);
    const params = new URLSearchParams({ genre: String(genreId) });
    const data = await api<{ results: SearchResult[] }>(
      `/discover/${type === 'movie' ? 'movies' : 'tv'}?${params.toString()}`
    );

    const hits = (data.results ?? []).slice(0, take ?? 10).map((r) => ({
      tmdbId: r.id,
      mediaType: r.mediaType,
      title: r.title ?? r.name ?? '(unknown)',
      year: (r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4) || null,
      libraryStatus: r.mediaInfo?.status
        ? (statusMap[r.mediaInfo.status] ?? 'unknown')
        : 'missing',
    }));

    const missing = hits.filter((h) => h.libraryStatus === 'missing').length;
    return envelope(
      `${plural(hits.length, `${type} ${genre} title`)} (${missing} not in library)`,
      hits
    );
  }),
  { annotations: { readOnlyHint: true } }
);

interface MediaDetail {
  id: number;
  mediaInfo?: { id: number; status?: number };
}

const issueTypeMap: Record<string, number> = {
  video: 1,
  audio: 2,
  subtitle: 3,
  other: 4,
};

export const overseerr_report_issue = tool(
  'overseerr_report_issue',
  'Report a quality issue (video, audio, subtitle, or other) with a title that is in the Plex library. Requires the TMDb ID — call overseerr_search first if needed.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the title'),
    mediaType: mediaTypeSchema.describe('movie or tv'),
    issueType: z
      .preprocess(normalizeIssueType, z.enum(['video', 'audio', 'subtitle', 'other']))
      .describe('Category of the problem'),
    message: z.string().min(1).describe('Description of the issue'),
  },
  safe(async ({ tmdbId, mediaType, issueType, message }) => {
    const type = normalizeMediaType(mediaType) as 'movie' | 'tv';
    const issue = normalizeIssueType(issueType) as 'video' | 'audio' | 'subtitle' | 'other';
    return once(
      `overseerr_report_issue:${type}:${tmdbId}:${issue}:${hashString(message)}`,
      async () => {
        const detail = await api<MediaDetail>(`/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}`);
        const mediaId = detail.mediaInfo?.id;

        if (!mediaId) {
          throw new Error(
            `No Overseerr media record found for TMDb ID ${tmdbId}. The title may not be in the library yet.`
          );
        }

        const data = await api('/issue', {
          method: 'POST',
          body: JSON.stringify({ mediaId, issueType: issueTypeMap[issue], message }),
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  }),
  { annotations: { readOnlyHint: false } }
);

interface PersonSearchResult {
  id: number;
  mediaType: 'person';
  name: string;
  knownForDepartment?: string;
  known_for_department?: string;
  knownFor?: { title?: string; name?: string; mediaType?: string }[];
}

export const overseerr_search_person = tool(
  'overseerr_search_person',
  'Search Overseerr/Seerr for a person (director, actor, writer) by name. Returns up to 5 matches with TMDb person ID and what they are best known for. Pair with overseerr_person_credits to list their filmography.',
  {
    query: z.string().describe('Person name to search for (e.g. "Stanley Kubrick")'),
  },
  safe(async ({ query }) => {
    const qs = `query=${encodeURIComponent(query)}`;
    const data = await api<{ results: (SearchResult | PersonSearchResult)[] }>(`/search?${qs}`);

    const hits = data.results
      .filter((r): r is PersonSearchResult => r.mediaType === 'person')
      .slice(0, 5)
      .map((r) => ({
        personId: r.id,
        name: r.name,
        knownFor: r.knownForDepartment ?? r.known_for_department ?? null,
        knownForTitles:
          r.knownFor
            ?.map((k) => k.title ?? k.name)
            .filter((t): t is string => Boolean(t))
            .slice(0, 3) ?? [],
      }));

    return envelope(`${plural(hits.length, 'person', 'people')} matching "${query}"`, hits);
  }),
  { annotations: { readOnlyHint: true } }
);

interface CombinedCreditCast {
  id: number;
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  character?: string;
  mediaInfo?: { id?: number; status?: number };
}

interface CombinedCreditCrew {
  id: number;
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  department?: string;
  job?: string;
  mediaInfo?: { id?: number; status?: number };
}

interface CombinedCredits {
  cast?: CombinedCreditCast[];
  crew?: CombinedCreditCrew[];
}

export const overseerr_person_credits = tool(
  'overseerr_person_credits',
  'List a person\'s filmography (movies + TV) with library status for each title. Use to answer "what Kubrick films am I missing" or similar gap-finder queries. Get the personId from overseerr_search_person first.',
  {
    personId: z.number().int().describe('TMDb person ID (from overseerr_search_person)'),
    role: z
      .preprocess(normalizeCreditRole, z.enum(['directing', 'writing', 'acting', 'all']))
      .optional()
      .describe('Filter by role. "directing" = jobs in Directing dept, "writing" = Writing dept, "acting" = cast credits, "all" = everything (default).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max titles to return (default 80)'),
  },
  safe(async ({ personId, role, limit }) => {
    const data = await api<CombinedCredits>(`/person/${personId}/combined_credits`);
    const max = limit ?? 80;
    const want = (normalizeCreditRole(role) as 'directing' | 'writing' | 'acting' | 'all' | undefined) ?? 'all';

    type Row = {
      tmdbId: number;
      mediaType: 'movie' | 'tv';
      title: string;
      year: string | null;
      role: string;
      libraryStatus: string;
      voteAverage?: number;
    };

    const rows: Row[] = [];

    const formatRow = (
      item: CombinedCreditCast | CombinedCreditCrew,
      roleLabel: string
    ): Row => ({
      tmdbId: item.id,
      mediaType: item.media_type,
      title: item.title ?? item.name ?? '(unknown)',
      year: (item.release_date ?? item.first_air_date ?? '').slice(0, 4) || null,
      role: roleLabel,
      libraryStatus: item.mediaInfo?.status
        ? (statusMap[item.mediaInfo.status] ?? 'unknown')
        : 'missing',
      ...(typeof item.vote_average === 'number' && item.vote_average > 0
        ? { voteAverage: Math.round(item.vote_average * 10) / 10 }
        : {}),
    });

    if (want === 'acting' || want === 'all') {
      for (const c of data.cast ?? []) {
        if (c.media_type !== 'movie' && c.media_type !== 'tv') continue;
        rows.push(formatRow(c, c.character ? `as ${c.character}` : 'Cast'));
      }
    }

    if (want === 'directing' || want === 'writing' || want === 'all') {
      for (const c of data.crew ?? []) {
        if (c.media_type !== 'movie' && c.media_type !== 'tv') continue;
        const isDirecting = c.department === 'Directing';
        const isWriting = c.department === 'Writing';
        if (want === 'directing' && !isDirecting) continue;
        if (want === 'writing' && !isWriting) continue;
        rows.push(formatRow(c, c.job ?? c.department ?? 'Crew'));
      }
    }

    // Deduplicate (a person can be both writer and director on the same film).
    const seen = new Map<string, Row>();
    for (const r of rows) {
      const key = `${r.mediaType}:${r.tmdbId}`;
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, r);
      } else {
        prev.role = `${prev.role}, ${r.role}`;
      }
    }

    const merged = [...seen.values()].sort((a, b) => {
      const ay = a.year ?? '0';
      const by = b.year ?? '0';
      return by.localeCompare(ay);
    });

    const shown = merged.slice(0, max);
    const missing = merged.filter((r) => r.libraryStatus === 'missing').length;
    const truncated = merged.length > max;
    return envelope(
      `${plural(merged.length, 'title')}, ${missing} missing from library${truncated ? ` (showing first ${max})` : ''}`,
      shown,
      { truncated, total: merged.length }
    );
  }),
  { annotations: { readOnlyHint: true } }
);

interface WatchProviderEntry {
  provider_id: number;
  provider_name: string;
}

interface WatchProviderRegion {
  iso_3166_1: string;
  link?: string;
  flatrate?: WatchProviderEntry[];
  rent?: WatchProviderEntry[];
  buy?: WatchProviderEntry[];
}

interface MediaWithWatchProviders {
  watchProviders?: WatchProviderRegion[];
  title?: string;
  name?: string;
}

export const overseerr_watch_providers = tool(
  'overseerr_watch_providers',
  'Check streaming/rent/buy availability for a movie or TV show in a given region. Useful before requesting something: if it\'s already on a streaming service the user subscribes to, they may not need to download a copy. Get the tmdbId from overseerr_search.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the title'),
    mediaType: mediaTypeSchema.describe('movie or tv'),
    region: z
      .string()
      .length(2)
      .optional()
      .describe('ISO 3166-1 alpha-2 country code (default "US")'),
  },
  safe(async ({ tmdbId, mediaType, region }) => {
    const type = normalizeMediaType(mediaType) as 'movie' | 'tv';
    const data = await api<MediaWithWatchProviders>(
      `/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}`
    );

    const reg = (region ?? 'US').toUpperCase();
    const match = (data.watchProviders ?? []).find((p) => p.iso_3166_1 === reg);

    const result = {
      title: data.title ?? data.name ?? null,
      region: reg,
      link: match?.link ?? null,
      streaming: (match?.flatrate ?? []).map((p) => p.provider_name),
      rent: (match?.rent ?? []).map((p) => p.provider_name),
      buy: (match?.buy ?? []).map((p) => p.provider_name),
      available: Boolean(match && (match.flatrate?.length || match.rent?.length || match.buy?.length)),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }),
  { annotations: { readOnlyHint: true } }
);

interface MediaDetailFull {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  mediaInfo?: { status?: number };
}

function createRequestKey(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  seasons?: number[]
): string {
  const seasonKey =
    mediaType === 'tv'
      ? seasons && seasons.length > 0
        ? [...seasons].sort((a, b) => a - b).join(',')
        : 'all'
      : 'all';
  return `overseerr_create_request:${mediaType}:${tmdbId}:${seasonKey}`;
}

export async function resolveCreateRequest(input: {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  seasons?: number[];
}): Promise<string[]> {
  const path = `/${input.mediaType === 'tv' ? 'tv' : 'movie'}/${input.tmdbId}`;
  const detail = await api<MediaDetailFull>(path);
  const title = detail.title ?? detail.name ?? `TMDb ${input.tmdbId}`;
  const year = (detail.releaseDate ?? detail.firstAirDate ?? '').slice(0, 4) || '?';
  const libStatus = detail.mediaInfo?.status ? (statusMap[detail.mediaInfo.status] ?? 'unknown') : 'missing';

  const lines = [`Request: ${title} (${year}) — ${input.mediaType}`];
  if (input.mediaType === 'tv') {
    const seasonText = input.seasons && input.seasons.length > 0 ? input.seasons.join(', ') : 'all';
    lines.push(`  Seasons: ${seasonText}`);
  }
  lines.push(`  Current library status: ${libStatus}`);
  return lines;
}

export const overseerr_create_request = tool(
  'overseerr_create_request',
  'Create a new Overseerr request. For TV, pass `seasons` as an array of season numbers (e.g. [1] for season 1 only) or omit for all seasons. This is a mutating operation — the harness will prompt for user confirmation.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the title (from overseerr_search)'),
    mediaType: mediaTypeSchema.describe('movie or tv'),
    seasons: z
      .array(z.number().int().min(1))
      .optional()
      .describe('TV only: list of season numbers to request. Omit for all seasons.'),
  },
  safe(async ({ tmdbId, mediaType, seasons }) => {
    const type = normalizeMediaType(mediaType) as 'movie' | 'tv';
    return once(createRequestKey(type, tmdbId, seasons), async () => {
      const detail = await api<MediaDetailFull>(`/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}`);
      const currentStatus = detail.mediaInfo?.status;
      if (currentStatus && [2, 3, 4, 5].includes(currentStatus)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  idempotent: true,
                  skipped: true,
                  duplicate: true,
                  reason: `Title is already ${statusMap[currentStatus] ?? 'requested/available'}.`,
                  tmdbId,
                  mediaType: type,
                  libraryStatus: statusMap[currentStatus] ?? 'unknown',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const body: Record<string, unknown> = { mediaId: tmdbId, mediaType: type };
      if (type === 'tv') {
        body.seasons = seasons && seasons.length > 0 ? seasons : 'all';
      }
      const data = await api('/request', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    });
  }),
  { annotations: { readOnlyHint: false } }
);
