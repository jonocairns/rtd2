import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { env } from '../env.js';
import { safe } from './errors.js';

function requireConfig(): { url: string; key: string } {
  if (!env.RADARR_URL || !env.RADARR_API_KEY) {
    throw new Error('RADARR_URL and RADARR_API_KEY must be set in .env to use Radarr tools.');
  }
  return { url: env.RADARR_URL, key: env.RADARR_API_KEY };
}

async function radarrApi<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const { url, key } = requireConfig();
  const res = await fetch(`${url}/api/v3${path}`, {
    ...init,
    headers: {
      'X-Api-Key': key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Radarr ${res.status} ${res.statusText} at ${path}: ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

export async function validateConnection(): Promise<void> {
  if (!env.RADARR_URL || !env.RADARR_API_KEY) return;
  await radarrApi('/system/status');
}

interface RadarrMovie {
  id: number;
  title: string;
  year: number;
  tmdbId: number;
  hasFile: boolean;
  movieFile?: { id: number; relativePath?: string; size?: number; quality?: { quality?: { name?: string } } };
}

export async function resolveReplaceMovie(input: {
  tmdbId: number;
  keepFile?: boolean;
}): Promise<string[]> {
  const matches = await radarrApi<RadarrMovie[]>(`/movie?tmdbId=${input.tmdbId}`);
  const movie = matches[0];
  if (!movie) {
    return [`Replace in Radarr: TMDb ${input.tmdbId} (not currently in Radarr)`];
  }

  const lines = [`Replace in Radarr: ${movie.title} (${movie.year})`];
  if (movie.hasFile && movie.movieFile) {
    const sizeGB = movie.movieFile.size
      ? `${(movie.movieFile.size / 1e9).toFixed(1)} GB`
      : 'unknown size';
    const quality = movie.movieFile.quality?.quality?.name ?? 'unknown quality';
    lines.push(`  Current file: ${quality}, ${sizeGB}`);
    if (movie.movieFile.relativePath) {
      lines.push(`  Path: ${movie.movieFile.relativePath}`);
    }
  } else {
    lines.push(`  Current file: none`);
  }
  lines.push(
    input.keepFile
      ? `  Action: trigger MoviesSearch (keep existing file)`
      : `  Action: delete file + trigger MoviesSearch`
  );
  return lines;
}

export async function resolveDeleteMovie(input: {
  tmdbId: number;
  deleteFiles?: boolean;
}): Promise<string[]> {
  const matches = await radarrApi<RadarrMovie[]>(`/movie?tmdbId=${input.tmdbId}`);
  const movie = matches[0];
  if (!movie) {
    return [`Delete from Radarr: TMDb ${input.tmdbId} (not currently in Radarr)`];
  }

  const lines = [`Delete from Radarr: ${movie.title} (${movie.year})`];
  if (movie.hasFile && movie.movieFile) {
    const sizeGB = movie.movieFile.size
      ? `${(movie.movieFile.size / 1e9).toFixed(1)} GB`
      : 'unknown size';
    const quality = movie.movieFile.quality?.quality?.name ?? 'unknown quality';
    lines.push(`  Current file: ${quality}, ${sizeGB}`);
    if (movie.movieFile.relativePath) lines.push(`  Path: ${movie.movieFile.relativePath}`);
  } else {
    lines.push(`  Current file: none`);
  }
  lines.push(
    input.deleteFiles
      ? `  Action: remove from Radarr + delete file from disk`
      : `  Action: remove from Radarr (keep file on disk)`
  );
  return lines;
}

export const radarr_delete_movie = tool(
  'radarr_delete_movie',
  'Remove a movie from Radarr entirely without triggering a re-download. Optionally deletes the file from disk. Use when you want to fully remove a title from Radarr. Requires the TMDb ID — call overseerr_search first. **MUTATING**.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the movie'),
    deleteFiles: z
      .boolean()
      .optional()
      .describe('If true, also delete the movie file from disk. Default false (removes from Radarr but keeps the file).'),
    addImportExclusion: z
      .boolean()
      .optional()
      .describe('If true, add an import exclusion so Radarr will not re-add the movie automatically. Default false.'),
  },
  safe(async ({ tmdbId, deleteFiles, addImportExclusion }) => {
    const matches = await radarrApi<RadarrMovie[]>(`/movie?tmdbId=${tmdbId}`);
    const movie = matches[0];
    if (!movie) {
      throw new Error(`No Radarr movie found for TMDb ID ${tmdbId}. The title may not be managed by Radarr.`);
    }

    const params = new URLSearchParams({
      deleteFiles: String(deleteFiles ?? false),
      addImportExclusion: String(addImportExclusion ?? false),
    });

    await radarrApi(`/movie/${movie.id}?${params}`, { method: 'DELETE' });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              radarrId: movie.id,
              title: movie.title,
              year: movie.year,
              deletedFromRadarr: true,
              filesDeletedFromDisk: deleteFiles ?? false,
            },
            null,
            2
          ),
        },
      ],
    };
  }),
  { annotations: { readOnlyHint: false } }
);

export const radarr_replace_movie = tool(
  'radarr_replace_movie',
  'Delete the current file for a movie in Radarr and trigger a fresh search for a replacement. Use when a downloaded release is bad (wrong cut, encoding issue, mislabeled). Requires the TMDb ID — call overseerr_search first. **MUTATING**: deletes the existing file.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the movie'),
    keepFile: z
      .boolean()
      .optional()
      .describe('If true, skip the file deletion and only trigger a new search. Default false.'),
  },
  safe(async ({ tmdbId, keepFile }) => {
    const matches = await radarrApi<RadarrMovie[]>(`/movie?tmdbId=${tmdbId}`);
    const movie = matches[0];
    if (!movie) {
      throw new Error(`No Radarr movie found for TMDb ID ${tmdbId}. The title may not be managed by Radarr.`);
    }

    const result: Record<string, unknown> = {
      radarrId: movie.id,
      title: movie.title,
      year: movie.year,
    };

    if (!keepFile && movie.hasFile && movie.movieFile?.id) {
      await radarrApi(`/moviefile/${movie.movieFile.id}`, { method: 'DELETE' });
      result.deleted = {
        path: movie.movieFile.relativePath ?? null,
        quality: movie.movieFile.quality?.quality?.name ?? null,
      };
    } else {
      result.deleted = null;
    }

    const command = await radarrApi<{ id: number; name: string; status: string }>('/command', {
      method: 'POST',
      body: JSON.stringify({ name: 'MoviesSearch', movieIds: [movie.id] }),
    });
    result.searchCommand = { id: command.id, status: command.status };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }),
  { annotations: { readOnlyHint: false } }
);
