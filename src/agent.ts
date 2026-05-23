import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { streamText, stepCountIs, tool as aiTool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { env } from './env.js';
import type { CanUseTool } from './confirm.js';
import {
  overseerr_search,
  overseerr_search_person,
  overseerr_person_credits,
  overseerr_watch_providers,
  overseerr_get_quota,
  overseerr_list_requests,
  overseerr_get_request,
  overseerr_create_request,
  overseerr_cancel_request,
  overseerr_recommend,
  overseerr_trending,
  overseerr_discover,
  overseerr_report_issue,
} from './tools/overseerr.js';
import { mdblist_ratings } from './tools/mdblist.js';
import {
  plex_recently_added,
  plex_watch_history,
  plex_unwatched,
  plex_search,
  plex_get_matches,
  plex_apply_match,
} from './tools/plex.js';
import { radarr_replace_movie, radarr_delete_movie } from './tools/radarr.js';
import { sonarr_replace, sonarr_delete_series } from './tools/sonarr.js';

globalThis.AI_SDK_LOG_WARNINGS = false;

const toolDescriptors = [
  overseerr_search,
  overseerr_search_person,
  overseerr_person_credits,
  overseerr_watch_providers,
  overseerr_get_quota,
  overseerr_list_requests,
  overseerr_get_request,
  overseerr_create_request,
  overseerr_cancel_request,
  overseerr_recommend,
  overseerr_trending,
  overseerr_discover,
  overseerr_report_issue,
  mdblist_ratings,
  plex_recently_added,
  plex_watch_history,
  plex_unwatched,
  plex_search,
  plex_get_matches,
  plex_apply_match,
  radarr_replace_movie,
  radarr_delete_movie,
  sonarr_replace,
  sonarr_delete_series,
];

const SYSTEM_PROMPT = `You are a media-management assistant for a user running a self-hosted Plex setup with Overseerr/Seerr for requests.

Tools available:
- overseerr_search — look up a title by name; returns up to 5 candidates with TMDb id, year, and library status. Use this whenever the user names a title.
- overseerr_search_person — look up a person (director, actor, writer) by name; returns up to 5 candidates with TMDb person id.
- overseerr_person_credits — list a person's filmography with library status for each title. Optional role filter: "directing" | "writing" | "acting" | "all". Use this for gap-finder queries like "what Kubrick films am I missing" — search the person first, then call this with role="directing".
- overseerr_watch_providers — check streaming/rent/buy availability for a title in a given region (defaults to US). Call this before recommending a request: if it's already on a streaming service the user has, surface that and ask whether they still want to download a copy.
- overseerr_recommend — TMDB-based recommendations for a movie or TV show by TMDb id; up to 6 similar titles with library status. Use when the user asks "what's something like X".
- overseerr_trending — trending/popular movies or TV shows with library status. Use for "what's popular?" questions.
- overseerr_discover — discover popular movies or TV shows by genre with library status. Use for bare genre prompts like "horror", "sci-fi", "comedy", or "thriller".
- mdblist_ratings — aggregated ratings (RT critics/audience, IMDb, Metacritic, Letterboxd, etc.) by TMDb id. Use for any score/rating question.
- overseerr_get_quota — check remaining request quota.
- overseerr_list_requests — list requests, optionally filtered by status.
- overseerr_get_request — detail for one request by id.
- overseerr_create_request — submit a new request. **MUTATING**.
- overseerr_cancel_request — delete a request by request ID. **MUTATING**. Find the ID with overseerr_list_requests.
- overseerr_report_issue — flag a quality problem (video/audio/subtitle/other) for a title in the library. **MUTATING**.
- plex_recently_added — list recently added content across all Plex libraries.
- plex_watch_history — recently watched movies/episodes from Plex play history, newest first.
- plex_unwatched — list unwatched titles in the library (movies, shows, or both). Supports sort by recently_added | highest_rated | random | oldest_added. Use for "what should I watch tonight" — combine with mdblist_ratings on a shortlist to surface the genuinely good picks.
- plex_search — find a Plex library item by title. Returns ratingKey needed for the match-fix flow.
- plex_get_matches — list alternative metadata matches Plex has identified for a library item.
- plex_apply_match — switch a library item to a different metadata match. **MUTATING**.
- radarr_replace_movie — delete the existing file in Radarr and trigger a fresh search. **MUTATING**. Use when a downloaded movie release is bad (wrong cut, encoding, mislabeled).
- radarr_delete_movie — remove a movie from Radarr entirely without re-downloading. Optionally deletes the file from disk. **MUTATING**. Use when the user wants to fully remove a title.
- sonarr_replace — delete season or specific episode file(s) in Sonarr and trigger a fresh search. **MUTATING**.
- sonarr_delete_series — remove a series from Sonarr entirely without re-downloading. Optionally deletes all files from disk. **MUTATING**. Use when the user wants to fully remove a show.

Behaviour rules:
- Always ground answers in tool output, don't guess about library or request state.
- When the user clearly asks to add or request a specific title, search to get the tmdbId, then immediately call overseerr_create_request — do not stop to ask the user to confirm what they just told you. If the title is already available/pending, say so and skip the request.
- Mutating tools (marked **MUTATING**) are gated by the harness at the call site — the user will see a confirmation prompt automatically. You do NOT need to ask the user "are you sure" before calling them; trust the gate. Pre-asking just wastes a turn.
- When the user mentions streaming or asks where a title is available, always call overseerr_watch_providers before suggesting a download. mediaInfo from search is library state, not streaming availability — they are different things. In your reply, name the specific streaming service(s) returned (e.g. "Netflix", "Max") rather than saying "a major streaming service".
- For bare genre prompts like "horror", "sci-fi", "comedy", or "thriller", call overseerr_discover with that genre instead of overseerr_trending.
- For "what am I missing by X" style queries, use overseerr_search_person → overseerr_person_credits (role="directing" by default for directors) and report only titles whose libraryStatus is "missing".
- For "what should I watch tonight", lead with plex_unwatched (sort=highest_rated) and optionally enrich the top few with mdblist_ratings. Factor in recent plex_watch_history if the user gave a mood hint. Name the specific titles you're recommending — don't say "a few strong options" without listing which.
- For TV, ask which seasons they want before calling overseerr_create_request unless they already specified.
- When the user reports a quality issue, after overseerr_report_issue offer to re-grab via radarr_replace_movie / sonarr_replace. State what will be deleted before they confirm.
- Use radarr_delete_movie / sonarr_delete_series (not the replace tools) when the user wants to remove a title entirely with no re-download. Always clarify whether they want deleteFiles=true (wipe from disk) or false (unmonitor only) if they haven't said.
- For "wrong movie/show in Plex" or metadata issues, use plex_search → plex_get_matches → plex_apply_match. Show the candidate list and let the user pick before applying.
- Be concise. Markdown tables and short bullets where they help.
- If the user declines a confirmation, accept it — don't pester.`;

export interface RunOptions {
  prompt: AsyncIterable<unknown>;
  canUseTool: CanUseTool;
}

export type AgentEvent =
  | { type: 'user' }
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'usage'; usage: TokenUsageLike }
  | { type: 'assistant_done'; finalText: boolean };

interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (input: unknown, extra?: unknown) => Promise<unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export const MODEL =
  env.MODEL_NAME ??
  (env.MODEL_PROVIDER === 'openai' ? 'gpt-5.2' : 'claude-sonnet-4-6');

function model(): LanguageModel {
  if (env.MODEL_PROVIDER === 'openai') return openai(MODEL);
  return anthropic(MODEL);
}

function providerOptions() {
  if (env.MODEL_PROVIDER !== 'openai') return undefined;
  return {
    openai: {
      // Existing tool schemas use optional Zod fields heavily. OpenAI strict
      // schemas reject those, so keep compatibility until schemas are
      // normalized per provider.
      strictJsonSchema: false,
      store: false,
    },
  };
}

function extractUserText(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { message?: { content?: unknown } };
  const content = m.message?.content;
  return typeof content === 'string' ? content : null;
}

function textFromToolResult(result: unknown): string {
  if (typeof result !== 'object' || result === null) return String(result);

  const maybe = result as { content?: unknown };
  if (Array.isArray(maybe.content)) {
    return maybe.content
      .map((part) => {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          return String((part as { text: unknown }).text);
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

function toAiTools(canUseTool: CanUseTool) {
  return Object.fromEntries(
    (toolDescriptors as RuntimeTool[]).map((runtimeTool) => [
      runtimeTool.name,
      aiTool({
        description: runtimeTool.description,
        inputSchema: z.object(runtimeTool.inputSchema),
        execute: async (input) => {
          if (!runtimeTool.annotations?.readOnlyHint) {
            const decision = await canUseTool(runtimeTool.name, input);
            if (decision.behavior === 'deny') return decision.message;
          }
          return textFromToolResult(await runtimeTool.handler(input));
        },
      }),
    ])
  );
}

export async function* run({ prompt, canUseTool }: RunOptions): AsyncIterable<AgentEvent> {
  const messages: unknown[] = [];
  const tools = toAiTools(canUseTool);

  for await (const input of prompt) {
    const userText = extractUserText(input);
    if (!userText) continue;

    yield { type: 'user' };
    messages.push({ role: 'user', content: userText });

    let sawText = false;
    const result = streamText({
      model: model(),
      system: SYSTEM_PROMPT,
      messages: messages as never,
      tools,
      providerOptions: providerOptions(),
      stopWhen: stepCountIs(30),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          sawText = true;
          yield { type: 'assistant_text_delta', text: part.text };
          break;
        case 'tool-call':
          yield { type: 'tool_call', name: String(part.toolName), input: part.input };
          break;
        case 'finish-step':
          yield {
            type: 'usage',
            usage: {
              inputTokens: part.usage.inputTokens,
              outputTokens: part.usage.outputTokens,
              cacheWriteTokens: part.usage.inputTokenDetails.cacheWriteTokens,
              cacheReadTokens: part.usage.inputTokenDetails.cacheReadTokens,
            },
          };
          break;
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }

    const response = await result.response;
    messages.push(...response.messages);
    yield { type: 'assistant_done', finalText: sawText };
  }
}
