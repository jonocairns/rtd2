import { tool } from './define.js';
import { z } from 'zod';
import { env } from '../env.js';
import { safe } from './errors.js';

interface MdbRating {
  source: string;
  value: number | null;
  score?: number | null;
  votes?: number | null;
  popular?: number | null;
  url?: string | null;
}

interface MdbResponse {
  title: string;
  year: number;
  type: string;
  imdbid: string;
  ratings: MdbRating[];
  score: number | null;
  score_average: number | null;
}

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

export const mdblist_ratings = tool(
  'mdblist_ratings',
  'Fetch aggregated ratings (Rotten Tomatoes, IMDb, Metacritic, Letterboxd, etc.) for a movie or TV show from MDBList. Requires the TMDb ID and media type — call overseerr_search first if you only have a title.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the title'),
    mediaType: z.enum(['movie', 'tv']).describe('movie or tv'),
  },
  safe(async ({ tmdbId, mediaType }) => {
    if (!env.MDBLIST_API_KEY) {
      return {
        content: [{ type: 'text', text: 'MDBLIST_API_KEY is not configured.' }],
      };
    }

    const params = new URLSearchParams({
      apikey: env.MDBLIST_API_KEY,
      tm: String(tmdbId),
      m: mediaType === 'tv' ? 'show' : 'movie',
    });

    const res = await fetch(`https://mdblist.com/api/?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MDBList ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as MdbResponse;

    const ratings = (data.ratings ?? [])
      .filter((r) => r.value !== null && r.value !== undefined)
      .map((r) => ({
        source: SOURCE_LABELS[r.source] ?? r.source,
        score: r.value,
        ...(r.votes ? { votes: r.votes } : {}),
      }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              title: data.title,
              year: data.year,
              imdbId: data.imdbid,
              ratings,
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
