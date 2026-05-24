import { stripAnsi } from './ui.js';
import type { AuditLog } from './audit.js';
import { resolveCreateRequest, resolveRequestAction } from './tools/overseerr.js';
import { guardReplaceMovie, resolveDeleteMovie, resolveReplaceMovie } from './tools/radarr.js';
import { guardReplace as guardReplaceEpisode, resolveDeleteSeries, resolveReplace } from './tools/sonarr.js';
import { resolveApplyMatch } from './tools/plex.js';

type Resolver = (input: Record<string, unknown>) => Promise<string[]>;

const RESOLVERS: Record<string, Resolver> = {
  overseerr_create_request: (i) =>
    resolveCreateRequest(i as Parameters<typeof resolveCreateRequest>[0]),
  overseerr_cancel_request: (i) =>
    resolveRequestAction({ ...(i as { id: number }), action: 'delete' }),
  overseerr_delete_request: (i) =>
    resolveRequestAction({ ...(i as { id: number }), action: 'delete' }),
  overseerr_approve_request: (i) =>
    resolveRequestAction({ ...(i as { id: number }), action: 'approve' }),
  overseerr_reject_request: (i) =>
    resolveRequestAction({ ...(i as { id: number }), action: 'reject' }),
  radarr_replace_movie: (i) => resolveReplaceMovie(i as Parameters<typeof resolveReplaceMovie>[0]),
  radarr_delete_movie: (i) => resolveDeleteMovie(i as Parameters<typeof resolveDeleteMovie>[0]),
  sonarr_replace: (i) => resolveReplace(i as Parameters<typeof resolveReplace>[0]),
  sonarr_delete_series: (i) =>
    resolveDeleteSeries(i as Parameters<typeof resolveDeleteSeries>[0]),
  plex_apply_match: (i) => resolveApplyMatch(i as Parameters<typeof resolveApplyMatch>[0]),
  'mcp__media-tools__overseerr_create_request': (i) =>
    resolveCreateRequest(i as Parameters<typeof resolveCreateRequest>[0]),
  'mcp__media-tools__overseerr_cancel_request': (i) =>
    resolveRequestAction({ ...(i as { id: number }), action: 'delete' }),
  'mcp__media-tools__overseerr_delete_request': (i) =>
    resolveRequestAction({ ...(i as { id: number }), action: 'delete' }),
  'mcp__media-tools__overseerr_approve_request': (i) =>
    resolveRequestAction({ ...(i as { id: number }), action: 'approve' }),
  'mcp__media-tools__overseerr_reject_request': (i) =>
    resolveRequestAction({ ...(i as { id: number }), action: 'reject' }),
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
  'overseerr_report_issue',
  'mcp__media-tools__overseerr_report_issue',
]);

export interface ConfirmRequest {
  displayName: string;
  input: unknown;
  lines: string[];
}

export interface BlockedNotice {
  title: string;
  lines: string[];
}

export interface ConfirmGateOptions {
  // Function so the App can toggle yolo mid-session via /yolo without
  // re-creating the gate. Read at every tool call.
  isYolo: () => boolean;
  audit: AuditLog;
  // Prompt the user with the resolved confirm box and return whether they approved.
  prompt: (req: ConfirmRequest) => Promise<boolean>;
  // Display a guard-block notice to the user (no prompt, just informational).
  notifyBlocked: (notice: BlockedNotice) => void;
}

export type ToolDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

export type CanUseTool = (toolName: string, input: unknown) => Promise<ToolDecision>;

export function createConfirmGate({ isYolo, audit, prompt, notifyBlocked }: ConfirmGateOptions): CanUseTool {
  return async (toolName, input) => {
    if (isYolo() || !MUTATING_TOOLS.has(toolName)) {
      return { behavior: 'allow' };
    }

    const displayName = toolName.replace(/^mcp__[^_]+__/, '');
    const resolver = RESOLVERS[toolName];

    let lines: string[];
    try {
      lines = resolver
        ? await resolver(input as Record<string, unknown>)
        : [
            displayName,
            ...JSON.stringify(input, null, 2).split('\n'),
          ];
    } catch (e) {
      lines = [
        displayName,
        `(could not resolve details: ${(e as Error).message})`,
        ...JSON.stringify(input, null, 2).split('\n'),
      ];
    }

    if (displayName === 'radarr_replace_movie') {
      try {
        const guard = await guardReplaceMovie(input as Parameters<typeof guardReplaceMovie>[0]);
        if (!guard.ok) {
          notifyBlocked({ title: 'Replacement blocked', lines: guard.lines });
          audit.append({
            type: 'confirm_decision',
            ts: new Date().toISOString(),
            tool: displayName,
            args: input,
            resolved: guard.lines.map(stripAnsi),
            decision: 'declined',
          });
          return { behavior: 'deny', message: guard.message };
        }
      } catch {
        // Resolver already surfaced lookup failures; let the normal confirm
        // path handle unusual preflight errors rather than hiding the operation.
      }
    }

    if (displayName === 'sonarr_replace') {
      try {
        const guard = await guardReplaceEpisode(input as Parameters<typeof guardReplaceEpisode>[0]);
        if (!guard.ok) {
          notifyBlocked({ title: 'Replacement blocked', lines: guard.lines });
          audit.append({
            type: 'confirm_decision',
            ts: new Date().toISOString(),
            tool: displayName,
            args: input,
            resolved: guard.lines.map(stripAnsi),
            decision: 'declined',
          });
          return { behavior: 'deny', message: guard.message };
        }
      } catch {
        // Same rationale as the radarr branch above.
      }
    }

    const approved = await prompt({ displayName, input, lines });

    audit.append({
      type: 'confirm_decision',
      ts: new Date().toISOString(),
      tool: displayName,
      args: input,
      resolved: lines.map(stripAnsi),
      decision: approved ? 'approved' : 'declined',
    });

    if (approved) return { behavior: 'allow' };
    return {
      behavior: 'deny',
      message: 'User declined. Do not retry without asking the user first.',
    };
  };
}
