import { tool } from './define.js';
import { z } from 'zod';
import { env } from '../env.js';
import { safe } from './errors.js';
import { once } from './idempotency.js';
import { envelope } from './output.js';

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
  episodeFile?: { quality?: { quality?: { name?: string } }; size?: number; relativePath?: string; path?: string };
}

interface SonarrRelease {
  guid?: string;
  indexerId?: number;
  title?: string;
  indexer?: string;
  size?: number;
  age?: number;
  language?: string;
  quality?: { quality?: { name?: string } };
  customFormatScore?: number;
  preferredWordScore?: number;
  releaseWeight?: number;
  rejected?: boolean;
  rejections?: string[];
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

const QUALITY_RANKS: Array<[RegExp, number]> = [
  [/2160|uhd|4k/i, 4000],
  [/1080/i, 3000],
  [/720/i, 2000],
  [/dvd|sdtv|480|576/i, 1000],
];

function qualityRank(name?: string | null): number | null {
  if (!name) return null;
  const hit = QUALITY_RANKS.find(([pattern]) => pattern.test(name));
  return hit?.[1] ?? null;
}

function qualityFloorName(rank: number | null): string | null {
  if (rank === null) return null;
  if (rank >= 4000) return '2160p';
  if (rank >= 3000) return '1080p';
  if (rank >= 2000) return '720p';
  return 'SD/480p';
}

function qualityFloorRank(name?: '2160p' | '1080p' | '720p' | '480p' | 'sd'): number {
  if (name === '2160p') return 4000;
  if (name === '720p') return 2000;
  if (name === '480p' || name === 'sd') return 1000;
  return 3000;
}

function sizeGiB(size?: number): number | null {
  return typeof size === 'number' ? Number((size / 1024 ** 3).toFixed(2)) : null;
}

function releaseScore(release: SonarrRelease): number {
  return release.customFormatScore ?? release.preferredWordScore ?? release.releaseWeight ?? 0;
}

function formatRelease(release: SonarrRelease) {
  const quality = release.quality?.quality?.name ?? null;
  return {
    guid: release.guid ?? null,
    indexerId: release.indexerId ?? null,
    title: release.title ?? null,
    indexer: release.indexer ?? null,
    quality,
    qualityRank: qualityRank(quality),
    sizeGiB: sizeGiB(release.size),
    ageDays: release.age ?? null,
    score: releaseScore(release),
    rejected: release.rejected ?? false,
    rejections: release.rejections ?? [],
  };
}

async function findSeriesAndEpisodes(input: {
  tmdbId: number;
  seasonNumber?: number;
  episodeNumber?: number;
}): Promise<{ series: SonarrSeries; episodes: SonarrEpisode[]; targets: SonarrEpisode[] }> {
  const tvdbId = await tmdbToTvdb(input.tmdbId);
  const seriesList = await sonarrApi<SonarrSeries[]>(`/series?tvdbId=${tvdbId}`);
  const series = seriesList[0];
  if (!series) {
    throw new Error(`No Sonarr series found for TVDB ID ${tvdbId} (TMDb ${input.tmdbId}).`);
  }

  const seasonFilter =
    input.seasonNumber === undefined ? '' : `&seasonNumber=${input.seasonNumber}`;
  const episodes = await sonarrApi<SonarrEpisode[]>(`/episode?seriesId=${series.id}${seasonFilter}`);
  const targets =
    input.seasonNumber !== undefined && input.episodeNumber !== undefined
      ? episodes.filter((e) => e.episodeNumber === input.episodeNumber)
      : episodes;

  if (targets.length === 0) {
    throw new Error(
      input.seasonNumber !== undefined && input.episodeNumber !== undefined
        ? `S${input.seasonNumber}E${input.episodeNumber} not found in Sonarr for "${series.title}".`
        : input.seasonNumber !== undefined
          ? `No episodes found for "${series.title}" season ${input.seasonNumber}.`
          : `No episodes found for "${series.title}".`
    );
  }

  return { series, episodes, targets };
}

function formatEpisodeQuality(episode: SonarrEpisode, floorRank: number) {
  const quality = currentEpisodeQuality(episode);
  const rank = qualityRank(quality);
  const missing = !episode.hasFile;
  const belowFloor = rank !== null && rank < floorRank;
  const unknownQuality = episode.hasFile && rank === null;
  const flags = [
    ...(missing ? ['missing file'] : []),
    ...(belowFloor ? [`quality below ${qualityFloorName(floorRank)}`] : []),
    ...(unknownQuality ? ['unknown quality'] : []),
  ];
  return {
    id: episode.id,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    hasFile: episode.hasFile,
    episodeFileId: episode.episodeFileId || null,
    quality,
    qualityRank: rank,
    sizeGiB: sizeGiB(episode.episodeFile?.size),
    path: episode.episodeFile?.relativePath ?? episode.episodeFile?.path ?? null,
    flags,
    needsUpgrade: flags.length > 0,
  };
}

async function candidateReleases(
  episodeId: number,
  take?: number,
  opts: { includeRejected?: boolean } = {}
) {
  const releases = await sonarrApi<SonarrRelease[]>(`/release?episodeId=${episodeId}`);
  return releases
    .filter((release) => opts.includeRejected || !release.rejected)
    .sort((a, b) => releaseScore(b) - releaseScore(a))
    .slice(0, take ?? releases.length);
}

async function replacementCandidates(episodeId: number, take = 8, includeRejected = false) {
  return (await candidateReleases(episodeId, take, { includeRejected })).map(formatRelease);
}

async function selectedRelease(episodeId: number, guid: string, indexerId?: number): Promise<SonarrRelease> {
  const releases = await candidateReleases(episodeId, undefined, { includeRejected: true });
  const selected = releases.find(
    (release) =>
      release.guid === guid &&
      (indexerId === undefined || release.indexerId === indexerId)
  );
  if (!selected) {
    throw new Error(
      indexerId === undefined
        ? `Selected Sonarr release guid ${guid} was not found in current candidates.`
        : `Selected Sonarr release guid ${guid} from indexer ${indexerId} was not found in current candidates.`
    );
  }
  return selected;
}

function currentEpisodeQuality(episode: SonarrEpisode): string | null {
  return episode.episodeFile?.quality?.quality?.name ?? null;
}

async function replacementSafety(episode: SonarrEpisode, selected?: SonarrRelease): Promise<{
  ok: boolean;
  topCandidate: ReturnType<typeof formatRelease> | null;
  selectedCandidate: ReturnType<typeof formatRelease> | null;
  floorRank: number | null;
  floorName: string | null;
  reason: string | null;
}> {
  const currentRank = qualityRank(currentEpisodeQuality(episode));
  const floorRank = currentRank ?? 3000;
  const candidates = selected ? [] : await replacementCandidates(episode.id, 5);
  const topCandidate = selected ? null : (candidates[0] ?? null);
  const candidate = selected ? formatRelease(selected) : topCandidate;

  if (!candidate) {
    return {
      ok: false,
      topCandidate: null,
      selectedCandidate: null,
      floorRank,
      floorName: qualityFloorName(floorRank),
      reason: 'No acceptable Sonarr release candidates were returned.',
    };
  }

  if (candidate.qualityRank === null) {
    return {
      ok: false,
      topCandidate,
      selectedCandidate: selected ? candidate : null,
      floorRank,
      floorName: qualityFloorName(floorRank),
      reason: `${selected ? 'Selected' : 'Top'} Sonarr candidate has unknown quality, so it cannot be compared with the replacement floor ${qualityFloorName(floorRank)}.`,
    };
  }

  if (candidate.qualityRank < floorRank) {
    return {
      ok: false,
      topCandidate,
      selectedCandidate: selected ? candidate : null,
      floorRank,
      floorName: qualityFloorName(floorRank),
      reason: `${selected ? 'Selected' : 'Top'} Sonarr candidate is ${candidate.quality ?? 'unknown quality'}, below the replacement floor ${qualityFloorName(floorRank)}.`,
    };
  }

  return {
    ok: true,
    topCandidate,
    selectedCandidate: selected ? candidate : null,
    floorRank,
    floorName: qualityFloorName(floorRank),
    reason: null,
  };
}

export async function guardReplace(input: {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber?: number;
  allowQualityDowngrade?: boolean;
  selectedReleaseGuid?: string;
  selectedReleaseIndexerId?: number;
}): Promise<{ ok: true } | { ok: false; lines: string[]; message: string }> {
  if (input.allowQualityDowngrade || input.selectedReleaseGuid || input.episodeNumber === undefined) {
    return { ok: true };
  }

  const { series, targets } = await findSeriesAndEpisodes(input);
  if (targets.length !== 1) return { ok: true };
  const safety = await replacementSafety(targets[0]);
  if (safety.ok) return { ok: true };

  const lines = [
    `Automatic Sonarr replacement blocked: ${series.title} S${String(input.seasonNumber).padStart(2, '0')}E${String(input.episodeNumber).padStart(2, '0')}`,
    `  Reason: ${safety.reason}`,
    `  Current quality floor: ${safety.floorName ?? 'unknown'}`,
    `  Next step: inspect sonarr_episode_replacement_candidates, recommend a specific candidate, then retry with selectedReleaseGuid + selectedReleaseIndexerId.`,
  ];
  return {
    ok: false,
    lines,
    message:
      `Automatic Sonarr replacement was blocked before confirmation: ${safety.reason} ` +
      'Call sonarr_episode_replacement_candidates, recommend a specific candidate with reasoning, and only retry sonarr_replace with selectedReleaseGuid + selectedReleaseIndexerId or an explicit allowQualityDowngrade=true from the user.',
  };
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
  allowQualityDowngrade?: boolean;
  selectedReleaseGuid?: string;
  selectedReleaseIndexerId?: number;
}): Promise<string[]> {
  let found: { series: SonarrSeries; targets: SonarrEpisode[] };
  try {
    found = await findSeriesAndEpisodes(input);
  } catch (e) {
    if (e instanceof Error && /No Sonarr series/.test(e.message)) {
      return [`Replace in Sonarr: TMDb ${input.tmdbId} (not currently in Sonarr)`];
    }
    throw e;
  }
  const { series, targets } = found;
  const withFiles = targets.filter((e) => e.hasFile);

  const target =
    input.episodeNumber !== undefined
      ? `S${String(input.seasonNumber).padStart(2, '0')}E${String(input.episodeNumber).padStart(2, '0')}`
      : `Season ${input.seasonNumber} (full)`;

  const lines = [`Replace in Sonarr: ${series.title} — ${target}`];
  lines.push(`  Episodes targeted: ${targets.length} (${withFiles.length} with existing files)`);
  lines.push(
    input.keepFile
      ? `  Action: ${input.selectedReleaseGuid ? 'grab selected release' : 'trigger search'} (keep existing files)`
      : `  Action: delete ${withFiles.length} file(s) + ${input.selectedReleaseGuid ? 'grab selected release' : 'trigger search'}`
  );
  if (input.allowQualityDowngrade) lines.push(`  Safety override: quality downgrade allowed`);

  if (input.episodeNumber !== undefined && targets.length === 1) {
    try {
      const selected = input.selectedReleaseGuid
        ? await selectedRelease(targets[0].id, input.selectedReleaseGuid, input.selectedReleaseIndexerId)
        : undefined;
      const safety = await replacementSafety(targets[0], selected);
      const candidate = safety.selectedCandidate ?? safety.topCandidate;
      if (candidate) {
        lines.push(
          `  ${selected ? 'Selected' : 'Top'} candidate: ${candidate.quality ?? 'unknown quality'}, ${candidate.sizeGiB ?? '?'} GiB, score ${candidate.score}`
        );
        if (candidate.title) lines.push(`  Candidate title: ${candidate.title}`);
      }
      if (!safety.ok) lines.push(`  Warning: ${safety.reason}`);
    } catch (e) {
      lines.push(`  Warning: could not inspect replacement candidates: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return lines;
}

export const sonarr_episode_replacement_candidates = tool(
  'sonarr_episode_replacement_candidates',
  'Read-only preflight for replacing one Sonarr episode. Shows the current episode file and top releases for a specific season+episode, including rejected/manual candidates plus guid/indexerId for manual selection.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the series'),
    seasonNumber: z.number().int().min(0).describe('Season number'),
    episodeNumber: z.number().int().min(1).describe('Episode number'),
    count: z.number().int().min(1).max(20).optional().describe('Number of candidates to return (default 8)'),
  },
  safe(async ({ tmdbId, seasonNumber, episodeNumber, count }) => {
    const { series, targets } = await findSeriesAndEpisodes({ tmdbId, seasonNumber, episodeNumber });
    const episode = targets[0];
    const currentQuality = currentEpisodeQuality(episode);
    const currentRank = qualityRank(currentQuality);
    const candidates = await replacementCandidates(episode.id, count ?? 8, true);
    const acceptableCandidates = candidates.filter((candidate) => !candidate.rejected);

    return envelope(
      `${candidates.length} Sonarr replacement candidates for ${series.title} S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`,
      candidates,
      {
        episode: {
          id: episode.id,
          title: episode.title,
          seasonNumber,
          episodeNumber,
        },
        currentFile: episode.hasFile
          ? {
              episodeFileId: episode.episodeFileId,
              quality: currentQuality,
              qualityRank: currentRank,
              sizeGiB: sizeGiB(episode.episodeFile?.size),
              path: episode.episodeFile?.relativePath ?? episode.episodeFile?.path ?? null,
            }
          : null,
        safety: {
          replacementFloor: qualityFloorName(currentRank ?? 3000),
          acceptableCandidateCount: acceptableCandidates.length,
          noAcceptableCandidates: acceptableCandidates.length === 0,
          topCandidateBelowFloor:
            acceptableCandidates[0]?.qualityRank !== null &&
            acceptableCandidates[0]?.qualityRank !== undefined &&
            acceptableCandidates[0].qualityRank < (currentRank ?? 3000),
        },
      }
    );
  }),
  { annotations: { readOnlyHint: true } }
);

export const sonarr_file_quality_check = tool(
  'sonarr_file_quality_check',
  'Read-only quality check for a Sonarr series, season, or exact episode. Lists current file quality, missing files, low-quality files, and whether a whole-season search or per-episode override workflow fits.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the series'),
    seasonNumber: z.number().int().min(0).optional().describe('Optional season number. Omit to check all episodes in the series.'),
    episodeNumber: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Optional episode number. Requires seasonNumber.'),
    minQuality: z
      .enum(['2160p', '1080p', '720p', '480p', 'sd'])
      .optional()
      .describe('Quality floor for flagging low-quality episodes (default 1080p).'),
    includeOk: z.boolean().optional().describe('If true, include episodes that already meet the quality floor. Default false.'),
  },
  safe(async ({ tmdbId, seasonNumber, episodeNumber, minQuality, includeOk }) => {
    if (episodeNumber !== undefined && seasonNumber === undefined) {
      throw new Error('episodeNumber requires seasonNumber.');
    }

    const floorRank = qualityFloorRank(minQuality);
    const { series, targets } = await findSeriesAndEpisodes({ tmdbId, seasonNumber, episodeNumber });
    const episodes = targets.map((episode) => formatEpisodeQuality(episode, floorRank));
    const issues = episodes.filter((episode) => episode.needsUpgrade);
    const returned = includeOk ? episodes : issues;
    const seasonsWithIssues = Array.from(new Set(issues.map((episode) => episode.seasonNumber))).sort(
      (a, b) => a - b
    );

    const scope =
      seasonNumber === undefined
        ? 'series'
        : episodeNumber === undefined
          ? `season ${seasonNumber}`
          : `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;

    return envelope(`${issues.length} Sonarr quality issue(s) for ${series.title} ${scope}`, returned, {
      series: {
        id: series.id,
        title: series.title,
        tvdbId: series.tvdbId,
      },
      scope: {
        seasonNumber: seasonNumber ?? null,
        episodeNumber: episodeNumber ?? null,
      },
      rules: {
        minQuality: qualityFloorName(floorRank),
        minQualityRank: floorRank,
      },
      counts: {
        episodesChecked: episodes.length,
        missingFiles: issues.filter((episode) => episode.flags.includes('missing file')).length,
        belowQualityFloor: issues.filter((episode) =>
          episode.flags.some((flag) => flag.startsWith('quality below '))
        ).length,
        unknownQuality: issues.filter((episode) => episode.flags.includes('unknown quality')).length,
      },
      recommendedActions:
        seasonNumber !== undefined && episodeNumber === undefined
          ? [
              {
                label: 'Whole-season automatic search',
                tool: 'sonarr_replace',
                args: { tmdbId, seasonNumber, keepFile: true },
                when: 'Use when several episodes are missing or low quality and Sonarr profile settings are trusted.',
              },
              {
                label: 'Per-episode candidate override',
                tool: 'sonarr_episode_replacement_candidates',
                args: { tmdbId, seasonNumber, episodeNumber: '<episodeNumber>' },
                when: 'Use for specific bad episodes, or when automatic search has no acceptable candidate.',
              },
            ]
          : episodeNumber !== undefined
            ? [
                {
                  label: 'Inspect exact episode candidates',
                  tool: 'sonarr_episode_replacement_candidates',
                  args: { tmdbId, seasonNumber, episodeNumber },
                  when: 'Use before deleting or grabbing a selected release.',
                },
              ]
            : [
                {
                  label: 'Season automatic search',
                  tool: 'sonarr_replace',
                  args: { tmdbId, seasonNumber: '<seasonNumber>', keepFile: true },
                  when: 'Use one season at a time after reviewing seasonsWithIssues.',
                },
              ],
      seasonsWithIssues,
    });
  }),
  { annotations: { readOnlyHint: true } }
);

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
  'Delete existing episode file(s) in Sonarr and trigger a fresh search, or grab a selected release for one episode. Use sonarr_episode_replacement_candidates first when episode quality/scoring matters, then pass selectedReleaseGuid + selectedReleaseIndexerId for a user-approved recommended candidate. Pass seasonNumber to replace a full season, or seasonNumber+episodeNumber to replace one episode. **MUTATING**: deletes existing files unless keepFile=true.',
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
    allowQualityDowngrade: z
      .boolean()
      .optional()
      .describe('If true, allow replacement even when the automatic or selected candidate is below the current/default quality floor. Default false.'),
    selectedReleaseGuid: z
      .string()
      .optional()
      .describe('Optional release guid from sonarr_episode_replacement_candidates. Requires episodeNumber. If provided, grab this exact release instead of triggering EpisodeSearch.'),
    selectedReleaseIndexerId: z
      .number()
      .int()
      .optional()
      .describe('Optional release indexerId from sonarr_episode_replacement_candidates. Recommended with selectedReleaseGuid.'),
  },
  safe(async ({
    tmdbId,
    seasonNumber,
    episodeNumber,
    keepFile,
    allowQualityDowngrade,
    selectedReleaseGuid,
    selectedReleaseIndexerId,
  }) =>
    once(
      `sonarr_replace:${tmdbId}:${seasonNumber}:${episodeNumber ?? 'all'}:${keepFile ?? false}:${allowQualityDowngrade ?? false}:${selectedReleaseGuid ?? 'auto'}:${selectedReleaseIndexerId ?? 'any'}`,
      async () => {
        if (selectedReleaseGuid && episodeNumber === undefined) {
          throw new Error('selectedReleaseGuid requires episodeNumber; selected release replacement is only supported for one episode.');
        }
        const { series, targets } = await findSeriesAndEpisodes({ tmdbId, seasonNumber, episodeNumber });

        const releaseToGrab =
          selectedReleaseGuid && targets.length === 1
            ? await selectedRelease(targets[0].id, selectedReleaseGuid, selectedReleaseIndexerId)
            : null;
        const safety =
          episodeNumber !== undefined && targets.length === 1
            ? await replacementSafety(targets[0], releaseToGrab ?? undefined)
            : null;
        if (safety && !allowQualityDowngrade && !safety.ok) {
          throw new Error(
            `${safety.reason} Refusing to delete the current file. Inspect sonarr_episode_replacement_candidates or retry with allowQualityDowngrade=true if this is intentional.`
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
          releaseToGrab
            ? null
            : episodeNumber !== undefined
            ? await sonarrApi<{ id: number; status: string }>('/command', {
                method: 'POST',
                body: JSON.stringify({ name: 'EpisodeSearch', episodeIds: targets.map((t) => t.id) }),
              })
            : await sonarrApi<{ id: number; status: string }>('/command', {
                method: 'POST',
                body: JSON.stringify({ name: 'SeasonSearch', seriesId: series.id, seasonNumber }),
              });

        const releaseGrab = releaseToGrab
          ? await sonarrApi('/release', {
              method: 'POST',
              body: JSON.stringify(releaseToGrab),
            })
          : null;

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
                  replacementMode: releaseToGrab ? 'selected_release' : 'automatic_search',
                  replacementPreflight: safety,
                  ...(releaseToGrab
                    ? {
                        grabbedRelease: safety?.selectedCandidate ?? null,
                        releaseGrab: releaseGrab ?? { ok: true },
                      }
                    : {
                        searchCommand: { id: command?.id, status: command?.status },
                        selfCheck: await checkReplace({
                          seriesId: series.id,
                          seasonNumber,
                          episodeNumber,
                          episodeIds: targets.map((target) => target.id),
                          deletedFileIds: deleted.map((entry) => entry.episodeFileId),
                          commandId: command?.id ?? -1,
                        }),
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
