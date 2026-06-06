import { fetchMdbList, type RatingsFilter } from '../clients/mdblist/client.js';
import { PlexClient, type PlexPresenceInput } from '../clients/plex/client.js';

export interface FindMissingFromMdbListOptions {
  mdblistApiKey: string;
  plexUrl: string;
  plexToken: string;
  list: string;
  mediaType?: 'movie' | 'tv' | 'all';
  section?: 'movies' | 'shows' | 'all';
  limit?: number;
  offset?: number;
  ratingsFilter?: RatingsFilter;
}

export async function findMissingFromMdbList(opts: FindMissingFromMdbListOptions) {
  const list = await fetchMdbList({
    apiKey: opts.mdblistApiKey,
    list: opts.list,
    mediaType: opts.mediaType,
    limit: opts.limit,
    offset: opts.offset,
    ratingsFilter: opts.ratingsFilter,
  });

  const items: PlexPresenceInput[] = list.items.map((item) => ({
    tmdbId: item.tmdbId ?? undefined,
    imdbId: item.imdbId ?? undefined,
    tvdbId: item.tvdbId ?? undefined,
    title: item.title,
    year: item.year,
    mediaType: item.mediaType === 'movie' || item.mediaType === 'tv' ? item.mediaType : undefined,
  }));

  const plex = new PlexClient({ url: opts.plexUrl, token: opts.plexToken });
  const { index, verdicts } = await plex.checkPresence(items, opts.section ?? 'all');
  const presentCount = verdicts.filter((v) => v.inLibrary).length;
  const missing = verdicts.filter((v) => !v.inLibrary);

  return {
    list,
    librarySize: index.total,
    presentCount,
    missingCount: missing.length,
    missing,
  };
}
