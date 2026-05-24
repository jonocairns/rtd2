import { tool } from './define.js';
import { z } from 'zod';
import { env } from '../env.js';
import { safe } from './errors.js';
import { once } from './idempotency.js';
import { envelope } from './output.js';

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

interface RadarrRelease {
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

interface RadarrCommand {
  id: number;
  name?: string;
  status?: string;
  movieId?: number;
  movieIds?: number[];
  body?: { movieId?: number; movieIds?: number[] };
}

function commandMatchesMovie(command: RadarrCommand, commandId: number, movieId: number): boolean {
  if (command.id === commandId) return true;
  const ids = command.movieIds ?? command.body?.movieIds ?? [];
  return (
    command.name === 'MoviesSearch' &&
    (command.movieId === movieId || command.body?.movieId === movieId || ids.includes(movieId))
  );
}

const QUALITY_RANKS: Array<[RegExp, number]> = [
  [/2160|uhd|4k/i, 4000],
  [/1080/i, 3000],
  [/720/i, 2000],
  [/dvd|576|480/i, 1000],
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
  return 'DVD/480p';
}

function qualityFloorRank(name?: '2160p' | '1080p' | '720p' | '480p' | 'dvd'): number {
  if (name === '2160p') return 4000;
  if (name === '720p') return 2000;
  if (name === '480p' || name === 'dvd') return 1000;
  return 3000;
}

function sizeGiB(size?: number): number | null {
  return typeof size === 'number' ? Number((size / 1024 ** 3).toFixed(2)) : null;
}

function releaseScore(release: RadarrRelease): number {
  return release.customFormatScore ?? release.preferredWordScore ?? release.releaseWeight ?? 0;
}

function formatRelease(release: RadarrRelease) {
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

async function candidateReleases(
  movieId: number,
  take?: number,
  opts: { includeRejected?: boolean } = {}
) {
  const releases = await radarrApi<RadarrRelease[]>(`/release?movieId=${movieId}`);
  return releases
    .filter((release) => opts.includeRejected || !release.rejected)
    .sort((a, b) => releaseScore(b) - releaseScore(a))
    .slice(0, take ?? releases.length);
}

async function replacementCandidates(movieId: number, take = 8, includeRejected = false) {
  return (await candidateReleases(movieId, take, { includeRejected }))
    .map(formatRelease);
}

async function selectedRelease(movieId: number, guid: string, indexerId?: number): Promise<RadarrRelease> {
  const releases = await candidateReleases(movieId, undefined, { includeRejected: true });
  const selected = releases.find(
    (release) =>
      release.guid === guid &&
      (indexerId === undefined || release.indexerId === indexerId)
  );
  if (!selected) {
    throw new Error(
      indexerId === undefined
        ? `Selected Radarr release guid ${guid} was not found in current candidates.`
        : `Selected Radarr release guid ${guid} from indexer ${indexerId} was not found in current candidates.`
    );
  }
  return selected;
}

async function replacementSafety(movie: RadarrMovie, selected?: RadarrRelease): Promise<{
  ok: boolean;
  topCandidate: ReturnType<typeof formatRelease> | null;
  selectedCandidate: ReturnType<typeof formatRelease> | null;
  floorRank: number | null;
  floorName: string | null;
  reason: string | null;
}> {
  const currentQuality = movie.movieFile?.quality?.quality?.name ?? null;
  const currentRank = qualityRank(currentQuality);
  const floorRank = currentRank ?? 3000;
  const candidates = selected ? [] : await replacementCandidates(movie.id, 5);
  const topCandidate = selected ? null : (candidates[0] ?? null);
  const candidate = selected ? formatRelease(selected) : topCandidate;

  if (!candidate) {
    return {
      ok: false,
      topCandidate: null,
      selectedCandidate: null,
      floorRank,
      floorName: qualityFloorName(floorRank),
      reason: 'No acceptable Radarr release candidates were returned.',
    };
  }

  if (candidate.qualityRank === null) {
    return {
      ok: false,
      topCandidate,
      selectedCandidate: selected ? candidate : null,
      floorRank,
      floorName: qualityFloorName(floorRank),
      reason: `${selected ? 'Selected' : 'Top'} Radarr candidate has unknown quality, so it cannot be compared with the replacement floor ${qualityFloorName(floorRank)}.`,
    };
  }

  if (candidate.qualityRank < floorRank) {
    return {
      ok: false,
      topCandidate,
      selectedCandidate: selected ? candidate : null,
      floorRank,
      floorName: qualityFloorName(floorRank),
      reason: `${selected ? 'Selected' : 'Top'} Radarr candidate is ${candidate.quality ?? 'unknown quality'}, below the replacement floor ${qualityFloorName(floorRank)}.`,
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

export async function guardReplaceMovie(input: {
  tmdbId: number;
  allowQualityDowngrade?: boolean;
  selectedReleaseGuid?: string;
  selectedReleaseIndexerId?: number;
}): Promise<{ ok: true } | { ok: false; lines: string[]; message: string }> {
  if (input.allowQualityDowngrade || input.selectedReleaseGuid) return { ok: true };

  const matches = await radarrApi<RadarrMovie[]>(`/movie?tmdbId=${input.tmdbId}`);
  const movie = matches[0];
  if (!movie) return { ok: true };

  const safety = await replacementSafety(movie);
  if (safety.ok) return { ok: true };

  const lines = [
    `Automatic Radarr replacement blocked: ${movie.title} (${movie.year})`,
    `  Reason: ${safety.reason}`,
    `  Current quality floor: ${safety.floorName ?? 'unknown'}`,
    `  Next step: inspect radarr_replacement_candidates, recommend a specific candidate, then retry with selectedReleaseGuid + selectedReleaseIndexerId.`,
  ];
  return {
    ok: false,
    lines,
    message:
      `Automatic Radarr replacement was blocked before confirmation: ${safety.reason} ` +
      'Call radarr_replacement_candidates, recommend a specific candidate with reasoning, and only retry radarr_replace_movie with selectedReleaseGuid + selectedReleaseIndexerId or an explicit allowQualityDowngrade=true from the user.',
  };
}

async function checkReplaceMovie(opts: {
  tmdbId: number;
  movieId: number;
  commandId: number;
  expectedFileDeleted: boolean;
}): Promise<Record<string, unknown>> {
  try {
    const [matches, commands] = await Promise.all([
      radarrApi<RadarrMovie[]>(`/movie?tmdbId=${opts.tmdbId}`),
      radarrApi<RadarrCommand[]>('/command'),
    ]);
    const movie = matches[0];
    const hasFileAfter = movie?.hasFile ?? null;
    const searchCommandVisible = commands.some((command) =>
      commandMatchesMovie(command, opts.commandId, opts.movieId)
    );
    const fileStateOk = opts.expectedFileDeleted ? hasFileAfter === false : true;

    return {
      ok: fileStateOk && searchCommandVisible,
      hasFileAfter,
      expectedFileDeleted: opts.expectedFileDeleted,
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

export async function resolveReplaceMovie(input: {
  tmdbId: number;
  keepFile?: boolean;
  allowQualityDowngrade?: boolean;
  selectedReleaseGuid?: string;
  selectedReleaseIndexerId?: number;
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
      ? `  Action: ${input.selectedReleaseGuid ? 'grab selected release' : 'trigger MoviesSearch'} (keep existing file)`
      : `  Action: delete file + ${input.selectedReleaseGuid ? 'grab selected release' : 'trigger MoviesSearch'}`
  );
  if (input.allowQualityDowngrade) {
    lines.push(`  Safety override: quality downgrade allowed`);
  }

  try {
    const selected = input.selectedReleaseGuid
      ? await selectedRelease(movie.id, input.selectedReleaseGuid, input.selectedReleaseIndexerId)
      : undefined;
    const safety = await replacementSafety(movie, selected);
    const candidate = safety.selectedCandidate ?? safety.topCandidate;
    if (candidate) {
      lines.push(
        `  ${selected ? 'Selected' : 'Top'} candidate: ${candidate.quality ?? 'unknown quality'}, ${candidate.sizeGiB ?? '?'} GiB, score ${candidate.score}`
      );
      if (candidate.title) lines.push(`  Candidate title: ${candidate.title}`);
    }
    if (!safety.ok) {
      lines.push(`  Warning: ${safety.reason}`);
    }
  } catch (e) {
    lines.push(`  Warning: could not inspect replacement candidates: ${e instanceof Error ? e.message : String(e)}`);
  }
  return lines;
}

export const radarr_replacement_candidates = tool(
  'radarr_replacement_candidates',
  'Read-only preflight for a Radarr movie replacement. Shows the current file and top releases sorted by Radarr score, including rejected/manual candidates plus guid/indexerId for manual selection. Use this to recommend a specific candidate when Radarr\'s automatic choice has no acceptable candidate or is same-or-worse quality.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the movie'),
    count: z.number().int().min(1).max(20).optional().describe('Number of candidates to return (default 8)'),
  },
  safe(async ({ tmdbId, count }) => {
    const matches = await radarrApi<RadarrMovie[]>(`/movie?tmdbId=${tmdbId}`);
    const movie = matches[0];
    if (!movie) {
      throw new Error(`No Radarr movie found for TMDb ID ${tmdbId}. The title may not be managed by Radarr.`);
    }

    const currentQuality = movie.movieFile?.quality?.quality?.name ?? null;
    const currentRank = qualityRank(currentQuality);
    const candidates = await replacementCandidates(movie.id, count ?? 8, true);
    const acceptableCandidates = candidates.filter((candidate) => !candidate.rejected);
    return envelope(`${candidates.length} Radarr replacement candidates for ${movie.title} (${movie.year})`, candidates, {
      currentFile: movie.movieFile
        ? {
            path: movie.movieFile.relativePath ?? null,
            quality: currentQuality,
            qualityRank: currentRank,
            sizeGiB: sizeGiB(movie.movieFile.size),
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
    });
  }),
  { annotations: { readOnlyHint: true } }
);

export const radarr_file_quality_check = tool(
  'radarr_file_quality_check',
  'Read-only quality check for one Radarr movie. Shows current file quality, flags missing or low-quality files, and points to automatic or selected-release replacement workflows.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the movie'),
    minQuality: z
      .enum(['2160p', '1080p', '720p', '480p', 'dvd'])
      .optional()
      .describe('Quality floor for flagging the movie file (default 1080p).'),
  },
  safe(async ({ tmdbId, minQuality }) => {
    const matches = await radarrApi<RadarrMovie[]>(`/movie?tmdbId=${tmdbId}`);
    const movie = matches[0];
    if (!movie) {
      throw new Error(`No Radarr movie found for TMDb ID ${tmdbId}. The title may not be managed by Radarr.`);
    }

    const floorRank = qualityFloorRank(minQuality);
    const currentQuality = movie.movieFile?.quality?.quality?.name ?? null;
    const currentRank = qualityRank(currentQuality);
    const flags = [
      ...(!movie.hasFile ? ['missing file'] : []),
      ...(currentRank !== null && currentRank < floorRank ? [`quality below ${qualityFloorName(floorRank)}`] : []),
      ...(movie.hasFile && currentRank === null ? ['unknown quality'] : []),
    ];

    return envelope(`${flags.length} Radarr quality issue(s) for ${movie.title} (${movie.year})`, [], {
      movie: {
        id: movie.id,
        title: movie.title,
        year: movie.year,
        tmdbId: movie.tmdbId,
      },
      currentFile: movie.movieFile
        ? {
            path: movie.movieFile.relativePath ?? null,
            quality: currentQuality,
            qualityRank: currentRank,
            sizeGiB: sizeGiB(movie.movieFile.size),
          }
        : null,
      flags,
      needsUpgrade: flags.length > 0,
      rules: {
        minQuality: qualityFloorName(floorRank),
        minQualityRank: floorRank,
      },
      recommendedActions: [
        {
          label: 'Inspect replacement candidates',
          tool: 'radarr_replacement_candidates',
          args: { tmdbId },
          when: 'Use before deleting or grabbing a selected release.',
        },
        {
          label: 'Automatic movie search',
          tool: 'radarr_replace_movie',
          args: { tmdbId, keepFile: true },
          when: 'Use when the Radarr profile is trusted and a normal MoviesSearch should find an upgrade.',
        },
      ],
    });
  }),
  { annotations: { readOnlyHint: true } }
);

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
  safe(async ({ tmdbId, deleteFiles, addImportExclusion }) =>
    once(`radarr_delete_movie:${tmdbId}:${deleteFiles ?? false}:${addImportExclusion ?? false}`, async () => {
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
    })
  ),
  { annotations: { readOnlyHint: false } }
);

export const radarr_replace_movie = tool(
  'radarr_replace_movie',
  'Delete the current file for a movie in Radarr and either trigger a fresh automatic search or grab a selected release. Refuses to delete when the automatic top candidate or selected candidate is below the current quality floor unless allowQualityDowngrade=true. Use radarr_replacement_candidates first when quality matters, then pass selectedReleaseGuid + selectedReleaseIndexerId for a user-approved recommended candidate. Requires the TMDb ID — call overseerr_search first. **MUTATING**: deletes the existing file unless keepFile=true.',
  {
    tmdbId: z.number().int().describe('TMDb ID of the movie'),
    keepFile: z
      .boolean()
      .optional()
      .describe('If true, skip the file deletion and only trigger a new search. Default false.'),
    allowQualityDowngrade: z
      .boolean()
      .optional()
      .describe('If true, allow replacement even when Radarr\'s top candidate is below the current/default quality floor. Default false.'),
    selectedReleaseGuid: z
      .string()
      .optional()
      .describe('Optional release guid from radarr_replacement_candidates. If provided, grab this exact release instead of triggering MoviesSearch.'),
    selectedReleaseIndexerId: z
      .number()
      .int()
      .optional()
      .describe('Optional release indexerId from radarr_replacement_candidates. Recommended with selectedReleaseGuid to disambiguate releases.'),
  },
  safe(async ({ tmdbId, keepFile, allowQualityDowngrade, selectedReleaseGuid, selectedReleaseIndexerId }) =>
    once(
      `radarr_replace_movie:${tmdbId}:${keepFile ?? false}:${allowQualityDowngrade ?? false}:${selectedReleaseGuid ?? 'auto'}:${selectedReleaseIndexerId ?? 'any'}`,
      async () => {
      const matches = await radarrApi<RadarrMovie[]>(`/movie?tmdbId=${tmdbId}`);
      const movie = matches[0];
      if (!movie) {
        throw new Error(`No Radarr movie found for TMDb ID ${tmdbId}. The title may not be managed by Radarr.`);
      }

      const releaseToGrab = selectedReleaseGuid
        ? await selectedRelease(movie.id, selectedReleaseGuid, selectedReleaseIndexerId)
        : null;
      const safety = await replacementSafety(movie, releaseToGrab ?? undefined);
      if (!allowQualityDowngrade && !safety.ok) {
        throw new Error(
          `${safety.reason} Refusing to delete the current file. Inspect radarr_replacement_candidates or retry with allowQualityDowngrade=true if this is intentional.`
        );
      }

      const result: Record<string, unknown> = {
        radarrId: movie.id,
        title: movie.title,
        year: movie.year,
        replacementPreflight: safety,
        replacementMode: releaseToGrab ? 'selected_release' : 'automatic_search',
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

      if (releaseToGrab) {
        const grabbed = await radarrApi('/release', {
          method: 'POST',
          body: JSON.stringify(releaseToGrab),
        });
        result.grabbedRelease = safety.selectedCandidate;
        result.releaseGrab = grabbed ?? { ok: true };
      } else {
        const command = await radarrApi<{ id: number; name: string; status: string }>('/command', {
          method: 'POST',
          body: JSON.stringify({ name: 'MoviesSearch', movieIds: [movie.id] }),
        });
        result.searchCommand = { id: command.id, status: command.status };
        result.selfCheck = await checkReplaceMovie({
          tmdbId,
          movieId: movie.id,
          commandId: command.id,
          expectedFileDeleted: !keepFile && movie.hasFile && Boolean(movie.movieFile?.id),
        });
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    )
  ),
  { annotations: { readOnlyHint: false } }
);
