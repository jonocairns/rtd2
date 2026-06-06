export interface PlexGuid {
  id: string;
}

export interface PlexMetadata {
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
}

export interface PlexResponse {
  MediaContainer: {
    size?: number;
    Metadata?: PlexMetadata[];
  };
}

export interface PlexSection {
  key: string;
  type: string;
  title: string;
}

export interface PlexSectionsResponse {
  MediaContainer: { Directory?: PlexSection[] };
}

export interface LibraryIndex {
  byImdb: Map<string, PlexMetadata>;
  byTmdb: Map<string, PlexMetadata>;
  byTvdb: Map<string, PlexMetadata>;
  byTitleYear: Map<string, PlexMetadata>;
  total: number;
}

export interface PlexPresenceInput {
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
  title?: string;
  year?: number;
  mediaType?: 'movie' | 'tv';
}

export interface PlexPresenceVerdict {
  input: PlexPresenceInput;
  inLibrary: boolean;
  matchedBy: 'imdb' | 'tmdb' | 'tvdb' | 'title' | null;
  match: PlexMetadata | null;
}

export function normalizePlexSection(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (['movie', 'film', 'films'].includes(normalized)) return 'movies';
  if (['show', 'tv', 'series', 'tvshow', 'tvshows'].includes(normalized)) return 'shows';
  return value;
}

export function normalizeTitleKey(title: string, year?: number): string {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${normalized}|${year ?? ''}`;
}

export function pickSections(sections: PlexSection[], filter: 'movies' | 'shows' | 'all'): PlexSection[] {
  return sections.filter((s) => {
    if (filter === 'all') return s.type === 'movie' || s.type === 'show';
    if (filter === 'movies') return s.type === 'movie';
    return s.type === 'show';
  });
}

export function indexLibrary(items: PlexMetadata[]): LibraryIndex {
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

export function checkPresence(index: LibraryIndex, items: PlexPresenceInput[]): PlexPresenceVerdict[] {
  return items.map((input) => {
    let match: PlexMetadata | undefined;
    let matchedBy: PlexPresenceVerdict['matchedBy'] = null;
    if (input.imdbId && (match = index.byImdb.get(input.imdbId))) matchedBy = 'imdb';
    else if (input.tmdbId != null && (match = index.byTmdb.get(String(input.tmdbId)))) matchedBy = 'tmdb';
    else if (input.tvdbId != null && (match = index.byTvdb.get(String(input.tvdbId)))) matchedBy = 'tvdb';
    else if (input.title && input.year && (match = index.byTitleYear.get(normalizeTitleKey(input.title, input.year)))) matchedBy = 'title';
    return { input, inLibrary: !!match, matchedBy, match: match ?? null };
  });
}

export class PlexClient {
  constructor(private readonly opts: { url: string; token: string }) {}

  async api<T = unknown>(
    path: string,
    params?: Record<string, string>,
    init?: RequestInit
  ): Promise<T> {
    const url = new URL(`${this.opts.url}${path}`);
    url.searchParams.set('X-Plex-Token', this.opts.token);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      ...init,
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': this.opts.token,
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

  async listSections(): Promise<PlexSection[]> {
    const data = await this.api<PlexSectionsResponse>('/library/sections');
    return data.MediaContainer.Directory ?? [];
  }

  async loadLibraryIndex(filter: 'movies' | 'shows' | 'all'): Promise<LibraryIndex> {
    const sections = await this.listSections();
    const wanted = pickSections(sections, filter);
    if (wanted.length === 0) {
      return {
        byImdb: new Map(),
        byTmdb: new Map(),
        byTvdb: new Map(),
        byTitleYear: new Map(),
        total: 0,
      };
    }
    const responses = await Promise.all(
      wanted.map((sec) =>
        this.api<PlexResponse>(`/library/sections/${sec.key}/all`, {
          'X-Plex-Container-Start': '0',
          'X-Plex-Container-Size': '100000',
          includeGuids: '1',
        })
      )
    );
    return indexLibrary(responses.flatMap((data) => data.MediaContainer.Metadata ?? []));
  }

  async checkPresence(
    items: PlexPresenceInput[],
    filter: 'movies' | 'shows' | 'all'
  ): Promise<{ index: LibraryIndex; verdicts: PlexPresenceVerdict[] }> {
    const index = await this.loadLibraryIndex(filter);
    return { index, verdicts: checkPresence(index, items) };
  }
}
