import { tool } from './define.js';
import { z } from 'zod';
import { env } from '../env.js';
import { safe } from './errors.js';
import { once } from './idempotency.js';

function requireConfig(): { url: string; key: string } {
  if (!env.SONARR_URL || !env.SONARR_API_KEY) {
    throw new Error('SONARR_URL and SONARR_API_KEY must be set in .env to use Sonarr tools.');
  }
  return { url: env.SONARR_URL, key: env.SONARR_API_KEY };
}

async function sonarrApi<T = unknown>(path: string, init?: RequestInit): Promise<T> {
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
    throw new Error(`Sonarr ${res.status} ${res.statusText} at ${path}: ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

export async function validateConnection(): Promise<void> {
  if (!env.SONARR_URL || !env.SONARR_API_KEY) return;
  await sonarrApi('/system/status');
}

// Sonarr is keyed on TVDB; Overseerr stores both TMDb and TVDB on its media record.
// Fetch the Overseerr TV detail to map tmdbId → tvdbId.
async function tmdbToTvdb(tmdbId: number): Promise<number> {
  const res = await fetch(`${env.OVERSEERR_URL}/api/v1/tv/${tmdbId}`, {
    headers: { 'X-Api-Key': env.OVERSEERR_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Overseerr lookup failed for tmdbId=${tmdbId}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { externalIds?: { tvdbId?: number } };
  const tvdbId = data.externalIds?.tvdbId;
  if (!tvdbId) {
    throw new Error(`No TVDB ID found for TMDb ID ${tmdbId} (required for Sonarr).`);
  }
  return tvdbId;
}

interface SonarrSeries {
  id: number;
  title: string;
  tvdbId: number;
}

interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeFileId: number;
  hasFile: boolean;
  title: string;
}

interface SonarrCommand {
  id: number;
  name?: string;
  status?: string;
  seriesId?: number;
  seasonNumber?: number;
  episodeId?: number;
  episodeIds?: number[];
  body?: { seriesId?: number; seasonNumber?: number; episodeId?: number; episodeIds?: number[] };
}

function commandMatchesTarget(
  command: SonarrCommand,
  opts: {
    commandId: number;
    seriesId: number;
    seasonNumber: number;
    episodeIds: number[];
    episodeNumber?: number;
  }
): boolean {
  if (command.id === opts.commandId) return true;
  const episodeIds = command.episodeIds ?? command.body?.episodeIds ?? [];
  if (opts.episodeNumber !== undefined) {
    return (
      command.name === 'EpisodeSearch' &&
      opts.episodeIds.every(
        (id) => episodeIds.includes(id) || command.episodeId === id || command.body?.episodeId === id
      )
    );
  }
  return (
    command.name === 'SeasonSearch' &&
    (command.seriesId === opts.seriesId || command.body?.seriesId === opts.seriesId) &&
    (command.seasonNumber === opts.seasonNumber || command.body?.seasonNumber === opts.seasonNumber)
  );
}

async function checkReplace(opts: {
  seriesId: number;
  seasonNumber: number;
  episodeNumber?: number;
  episodeIds: number[];
  deletedFileIds: number[];
  commandId: number;
}): Promise<Record<string, unknown>> {
  try {
    const [episodes, commands] = await Promise.all([
      sonarrApi<SonarrEpisode[]>(`/episode?seriesId=${opts.seriesId}&seasonNumber=${opts.seasonNumber}`),
      sonarrApi<SonarrCommand[]>('/command'),
    ]);
    const targets =
      opts.episodeNumber !== undefined
        ? episodes.filter((episode) => episode.episodeNumber === opts.episodeNumber)
        : episodes.filter((episode) => opts.episodeIds.includes(episode.id));
    const deletedFileIds = new Set(opts.deletedFileIds);
    const stillAttachedDeletedFiles = targets.filter(
      (episode) => episode.hasFile && deletedFileIds.has(episode.episodeFileId)
    );
    const fileStateOk = stillAttachedDeletedFiles.length === 0;
    const searchCommandVisible = commands.some((command) =>
      commandMatchesTarget(command, opts)
    );

    return {
      ok: fileStateOk && searchCommandVisible,
      targetedEpisodesAfter: targets.length,
      expectedFilesDeleted: opts.deletedFileIds.length,
      stillAttachedDeletedFiles: stillAttachedDeletedFiles.map((episode) => ({
        season: episode.seasonNumber,
        episode: episode.episodeNumber,
        episodeFileId: episode.episodeFileId,
      })),
      fileStateOk,
      searchCommandVisible,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function resolveReplace(input: {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber?: number;
  keepFile?: boolean;
}): Promise<string[]> {
  const tvdbId = await tmdbToTvdb(input.tmdbId);
  const seriesList = await sonarrApi<SonarrSeries[]>(`/series?tvdbId=${tvdbId}`);
  const series = seriesList[0];
  if (!series) {
    return [`Replace in Sonarr: TMDb ${input.tmdbId} (not currently in Sonarr)`];
  }

  const episodes = await sonarrApi<SonarrEpisode[]>(
    `/episode?seriesId=${series.id}&seasonNumber=${input.seasonNumber}`
  );
  const targets =
    input.episodeNumber !== undefined
      ? episodes.filter((e) => e.episodeNumber === input.episodeNumber)
      : episodes;
  const withFiles = targets.filter((e) => e.hasFile);

  const target =
    input.episodeNumber !== undefined
      ? `S${String(input.seasonNumber).padStart(2, '0')}E${String(input.episodeNumber).padStart(2, '0')}`
      : `Season ${input.seasonNumber} (full)`;

  const lines = [`Replace in Sonarr: ${series.title} — ${target}`];
  lines.push(`  Episodes targeted: ${targets.length} (${withFiles.length} with existing files)`);
  lines.push(
    input.keepFile
      ? `  Action: trigger search (keep existing files)`
      : `  Action: delete ${withFiles.length} file(s) + trigger search`
  );
  return lines;
}

export async function resolveDeleteSeries(input: {
  tmdbId: number;
  deleteFiles?: boolean;
}): Promise<string[]> {
  const tvdbId = await tmdbToTvdb(input.tmdbId);
  const seriesList = await sonarrApi<SonarrSeries[]>(`/series?tvdbId=${tvdbId}`);
  const series = seriesList[0];
  if (!series) {
    return [`Delete from Sonarr: TMDb ${input.tmdbId} (not currently in Sonarr)`];
  }

  const lines = [`Delete from Sonarr: ${series.title}`];
  lines.push(
    input.deleteFiles
      ? `  Action: remove from Sonarr + delete all files from disk`
      : `  Action: remove from Sonarr (keep files on disk)`
  );
  return lines;
}

export const sonarr_delete_series = tool(
  'sonarr_delete_series',
  'Remove a series from Sonarr entirely without triggering a re-download. Optionally deletes all episode files from disk. Use when you want to fully remove a show from Sonarr. Requires the TMDb ID — call overseerr_search first. **MUTATING**.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the series'),
    deleteFiles: z
      .boolean()
      .optional()
      .describe('If true, also delete all episode files from disk. Default false (removes from Sonarr but keeps files).'),
    addImportListExclusion: z
      .boolean()
      .optional()
      .describe('If true, add an import list exclusion so Sonarr will not re-add the series automatically. Default false.'),
  },
  safe(async ({ tmdbId, deleteFiles, addImportListExclusion }) =>
    once(
      `sonarr_delete_series:${tmdbId}:${deleteFiles ?? false}:${addImportListExclusion ?? false}`,
      async () => {
        const tvdbId = await tmdbToTvdb(tmdbId);
        const seriesList = await sonarrApi<SonarrSeries[]>(`/series?tvdbId=${tvdbId}`);
        const series = seriesList[0];
        if (!series) {
          throw new Error(`No Sonarr series found for TVDB ID ${tvdbId} (TMDb ${tmdbId}).`);
        }

        const params = new URLSearchParams({
          deleteFiles: String(deleteFiles ?? false),
          addImportListExclusion: String(addImportListExclusion ?? false),
        });

        await sonarrApi(`/series/${series.id}?${params}`, { method: 'DELETE' });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  sonarrId: series.id,
                  title: series.title,
                  deletedFromSonarr: true,
                  filesDeletedFromDisk: deleteFiles ?? false,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    )
  ),
  { annotations: { readOnlyHint: false } }
);

export const sonarr_replace = tool(
  'sonarr_replace',
  'Delete existing episode file(s) in Sonarr and trigger a fresh search. Use when a release is bad. Pass seasonNumber to replace a full season, or seasonNumber+episodeNumber to replace one episode. **MUTATING**: deletes existing files.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the series'),
    seasonNumber: z.number().int().min(0).describe('Season number to target'),
    episodeNumber: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Specific episode number to replace. Omit to replace the whole season.'),
    keepFile: z
      .boolean()
      .optional()
      .describe('If true, skip file deletion and only trigger a new search. Default false.'),
  },
  safe(async ({ tmdbId, seasonNumber, episodeNumber, keepFile }) =>
    once(
      `sonarr_replace:${tmdbId}:${seasonNumber}:${episodeNumber ?? 'all'}:${keepFile ?? false}`,
      async () => {
        const tvdbId = await tmdbToTvdb(tmdbId);
        const seriesList = await sonarrApi<SonarrSeries[]>(`/series?tvdbId=${tvdbId}`);
        const series = seriesList[0];
        if (!series) {
          throw new Error(`No Sonarr series found for TVDB ID ${tvdbId} (TMDb ${tmdbId}).`);
        }

        const episodes = await sonarrApi<SonarrEpisode[]>(
          `/episode?seriesId=${series.id}&seasonNumber=${seasonNumber}`
        );

        const targets =
          episodeNumber !== undefined
            ? episodes.filter((e) => e.episodeNumber === episodeNumber)
            : episodes;

        if (targets.length === 0) {
          throw new Error(
            episodeNumber !== undefined
              ? `S${seasonNumber}E${episodeNumber} not found in Sonarr for "${series.title}".`
              : `No episodes found for "${series.title}" season ${seasonNumber}.`
          );
        }

        const deleted: { season: number; episode: number; episodeFileId: number }[] = [];
        if (!keepFile) {
          const seenFileIds = new Set<number>();
          for (const ep of targets) {
            if (ep.hasFile && ep.episodeFileId > 0 && !seenFileIds.has(ep.episodeFileId)) {
              seenFileIds.add(ep.episodeFileId);
              deleted.push({
                season: ep.seasonNumber,
                episode: ep.episodeNumber,
                episodeFileId: ep.episodeFileId,
              });
            }
          }
          await Promise.all(
            deleted.map((d) =>
              sonarrApi(`/episodefile/${d.episodeFileId}`, { method: 'DELETE' })
            )
          );
        }

        const command =
          episodeNumber !== undefined
            ? await sonarrApi<{ id: number; status: string }>('/command', {
                method: 'POST',
                body: JSON.stringify({ name: 'EpisodeSearch', episodeIds: targets.map((t) => t.id) }),
              })
            : await sonarrApi<{ id: number; status: string }>('/command', {
                method: 'POST',
                body: JSON.stringify({ name: 'SeasonSearch', seriesId: series.id, seasonNumber }),
              });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  sonarrId: series.id,
                  title: series.title,
                  season: seasonNumber,
                  episode: episodeNumber ?? null,
                  deleted,
                  searchCommand: { id: command.id, status: command.status },
                  selfCheck: await checkReplace({
                    seriesId: series.id,
                    seasonNumber,
                    episodeNumber,
                    episodeIds: targets.map((target) => target.id),
                    deletedFileIds: deleted.map((entry) => entry.episodeFileId),
                    commandId: command.id,
                  }),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    )
  ),
  { annotations: { readOnlyHint: false } }
);
