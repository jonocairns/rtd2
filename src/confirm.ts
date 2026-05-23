import type readline from 'node:readline';
import { box, colors, Spinner, stripAnsi } from './ui.js';
import type { AuditLog } from './audit.js';
import { resolveCreateRequest } from './tools/overseerr.js';
import { resolveDeleteMovie, resolveReplaceMovie } from './tools/radarr.js';
import { resolveDeleteSeries, resolveReplace } from './tools/sonarr.js';
import { resolveApplyMatch } from './tools/plex.js';

type Resolver = (input: Record<string, unknown>) => Promise<string[]>;

const RESOLVERS: Record<string, Resolver> = {
  overseerr_create_request: (i) =>
    resolveCreateRequest(i as Parameters<typeof resolveCreateRequest>[0]),
  radarr_replace_movie: (i) => resolveReplaceMovie(i as Parameters<typeof resolveReplaceMovie>[0]),
  radarr_delete_movie: (i) => resolveDeleteMovie(i as Parameters<typeof resolveDeleteMovie>[0]),
  sonarr_replace: (i) => resolveReplace(i as Parameters<typeof resolveReplace>[0]),
  sonarr_delete_series: (i) =>
    resolveDeleteSeries(i as Parameters<typeof resolveDeleteSeries>[0]),
  plex_apply_match: (i) => resolveApplyMatch(i as Parameters<typeof resolveApplyMatch>[0]),
  'mcp__media-tools__overseerr_create_request': (i) =>
    resolveCreateRequest(i as Parameters<typeof resolveCreateRequest>[0]),
  'mcp__media-tools__radarr_replace_movie': (i) =>
    resolveReplaceMovie(i as Parameters<typeof resolveReplaceMovie>[0]),
  'mcp__media-tools__radarr_delete_movie': (i) =>
    resolveDeleteMovie(i as Parameters<typeof resolveDeleteMovie>[0]),
  'mcp__media-tools__sonarr_replace': (i) =>
    resolveReplace(i as Parameters<typeof resolveReplace>[0]),
  'mcp__media-tools__sonarr_delete_series': (i) =>
    resolveDeleteSeries(i as Parameters<typeof resolveDeleteSeries>[0]),
  'mcp__media-tools__plex_apply_match': (i) =>
    resolveApplyMatch(i as Parameters<typeof resolveApplyMatch>[0]),
};

const MUTATING_TOOLS = new Set([
  ...Object.keys(RESOLVERS),
  'overseerr_cancel_request',
  'overseerr_report_issue',
  'mcp__media-tools__overseerr_cancel_request',
  'mcp__media-tools__overseerr_report_issue',
]);

export interface ConfirmGateOptions {
  rl: readline.Interface;
  spinner: Spinner;
  yolo: boolean;
  audit: AuditLog;
}

export type ToolDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

export type CanUseTool = (toolName: string, input: unknown) => Promise<ToolDecision>;

export function createConfirmGate({ rl, spinner, yolo, audit }: ConfirmGateOptions): CanUseTool {
  return async (toolName, input) => {
    if (yolo || !MUTATING_TOOLS.has(toolName)) {
      return { behavior: 'allow' };
    }

    spinner.stop();

    const displayName = toolName.replace(/^mcp__[^_]+__/, '');
    const resolver = RESOLVERS[toolName];

    let lines: string[];
    spinner.start('resolving');
    try {
      lines = resolver
        ? await resolver(input as Record<string, unknown>)
        : [
            `${colors.bold}${displayName}${colors.reset}`,
            ...JSON.stringify(input, null, 2)
              .split('\n')
              .map((l) => `${colors.dim}${l}${colors.reset}`),
          ];
    } catch (e) {
      lines = [
        `${colors.bold}${displayName}${colors.reset}`,
        `${colors.red}(could not resolve details: ${(e as Error).message})${colors.reset}`,
        ...JSON.stringify(input, null, 2)
          .split('\n')
          .map((l) => `${colors.dim}${l}${colors.reset}`),
      ];
    }
    spinner.stop();

    box('Confirmation required', lines);

    const answer: string = await new Promise((resolve) =>
      rl.question(`${colors.yellow}Proceed? [y/N] ${colors.reset}`, resolve)
    );

    const proceed = answer.trim().toLowerCase() === 'y';
    spinner.start('processing');

    audit.append({
      type: 'confirm_decision',
      ts: new Date().toISOString(),
      tool: displayName,
      args: input,
      resolved: lines.map(stripAnsi),
      decision: proceed ? 'approved' : 'declined',
    });

    if (proceed) {
      return { behavior: 'allow' };
    }
    return {
      behavior: 'deny',
      message: 'User declined. Do not retry without asking the user first.',
    };
  };
}
