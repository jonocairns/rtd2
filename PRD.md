# media-agent — PRD

A REPL-based AI agent for managing a self-hosted media setup. You launch it, have a multi-turn conversation, and the agent uses its tools (Overseerr/Seerr, Plex) and skills (taste curation, library audits) to answer questions and perform actions on your library.

> **mdblist not included.** The user already runs [ListSync](https://github.com/Woahai321/list-sync) to import mdblist curated lists into Overseerr — that workflow doesn't need to live in this agent. For ad-hoc additions, the user names titles directly and the agent searches + requests them.

Built on the Claude Agent SDK (TypeScript) with skills as a first-class concept — the LLM is genuinely load-bearing here.

> **Note on Overseerr / Seerr.** The original Overseerr repo was archived Feb 2026 and superseded by [Seerr](https://seerr.dev/) (unified Overseerr + Jellyseerr). The REST API surface is largely the same, so we target the shared API and refer to it as "Overseerr/Seerr" throughout.

---

## 1. Goal

A conversational layer that ties together the self-hosted media tools the user already runs (Plex + Overseerr), so ad-hoc media management becomes a chat:

- *"What should I watch tonight, something like Severance but lighter?"*
- *"Add Dune: Part Three when it's available."*
- *"Any requests from last month that still haven't downloaded?"*
- *"What's in my library by Villeneuve? Any of his I'm missing?"*
- *"My library's gotten huge — what's gathering dust that I could prune?"*

The agent is the only thing the user interacts with. Tools and skills compose to handle each request.

## 2. Non-goals (v1)

- **No always-on daemon.** REPL launched on demand, exits when the user does. No service/background process.
- **No web UI.**
- **No general-purpose Sonarr/Radarr interface.** Overseerr remains the abstraction for *requests*. The one exception is the re-grab flow (delete a bad release + trigger a new search) — Overseerr can't do that, so we talk to Radarr/Sonarr directly for `radarr_replace_movie` and `sonarr_replace` only. Both are confirmation-gated.
- **No Tautulli in v1.** Plex direct covers library + history + ratings. Tautulli deferred to v2 for richer stats.
- **No 4K request handling.** HD only.
- **No multi-user.** Single Plex user.
- **No persistent memory across sessions.** Each session starts fresh — keeps things simple, avoids stale-context bugs. Multi-session memory is a v2 question.
- **No autonomous mutation.** Any tool that *changes* state (creates Overseerr requests) requires explicit user confirmation each time, unless `--yolo` mode is on (off by default).

## 3. User flow

```
$ media-agent
media-agent ready. Tools: overseerr, plex, mdblist. Skills: 5 loaded.

> what should I watch tonight, something like Severance but lighter?
[loading taste-profile skill]
[plex_history(90)] 142 watch events
[plex_library()] 412 titles
Three things in your library that fit:
  1. The Bear (S1) — workplace dread + dark humor, sharper pacing than Severance
  2. Bad Sisters — slow-burn, character-led, more comic
  3. Russian Doll — surreal-loop adjacent, lighter tone, short runtime
Want a deeper cut from outside your library too?

> just sync my mdblist rt-m into overseerr
[loading sync-mdblist skill]
[mdblist_get_list("rt-m")] 24 titles
[overseerr_search × 24] 18 already in library, 6 missing
Plan: request 6 titles → Arrival 2.0 (2026), Foe (2025), The Substance (2024), …
Confirm? [y/N] y
[overseerr_create_request × 6] 5 ok, 1 failed (quota exceeded on title #6)

> exit
```

Multi-turn, tools/skills surfaced as they're used (`[bracketed lines]` so you can see what's happening). Confirmation prompted explicitly before any mutation.

## 4. Architecture

- **Model:** Claude Sonnet 4.6 (`claude-sonnet-4-6`)
- **SDK:** `@anthropic-ai/claude-agent-sdk` (TypeScript)
- **Interaction:** REPL driven by `readline`. Each user turn is passed to the SDK's streaming `query()` interface; tool calls and skill loads are surfaced as they happen.
- **Tools:** TypeScript functions wrapped as SDK tools — see §5.
- **Skills:** Markdown under `skills/` loaded on-demand — see §6.
- **System prompt:** Establishes the agent's role (media librarian), the user's setup (Plex + Overseerr + mdblist), and the confirmation discipline (never mutate without explicit user confirmation).
- **Max turns per user query:** 30 (bounded; prevents runaway tool calls on a single query).

## 5. Tools (v1)

All tools are TypeScript functions wrapped as SDK tool definitions.

**Overseerr/Seerr** (read + write — writes are confirmation-gated):
- `overseerr_search(query, year?)` — search + library status of a title
- `overseerr_search_person(query)` — name → TMDb person id
- `overseerr_person_credits(personId, role?, limit?)` — filmography with library status per title; role filter `directing | writing | acting | all`. Powers gap-finder queries.
- `overseerr_watch_providers(tmdbId, mediaType, region?)` — streaming/rent/buy availability (default region US)
- `overseerr_recommend(tmdbId, mediaType)` — TMDB similar-titles
- `overseerr_trending(mediaType)` — discover trending
- `overseerr_list_requests(filters)` — list current requests
- `overseerr_get_request(id)` — request detail (status, download progress)
- `overseerr_get_quota()` — remaining requests for this user
- `overseerr_create_request(tmdbId, mediaType, seasons?)` — **mutating**; confirmation-gated
- `overseerr_cancel_request(id)` — delete a pending request
- `overseerr_report_issue(tmdbId, mediaType, issueType, message)` — flag a quality issue

**Plex** (read + write — writes are confirmation-gated):
- `plex_recently_added(count?)` — recently added library items
- `plex_watch_history(count?)` — recent play history
- `plex_unwatched(section?, sort?, count?)` — unwatched titles; sort `recently_added | highest_rated | random | oldest_added`
- `plex_search(query, count?)` — find a library item; returns ratingKey
- `plex_get_matches(ratingKey)` — alternative metadata candidates Plex has identified
- `plex_apply_match(ratingKey, guid, name?)` — switch a library item to a chosen match; **mutating**

**mdblist**:
- `mdblist_ratings(tmdbId, mediaType)` — aggregated ratings (RT critics/audience, IMDb, Metacritic, Letterboxd, etc.)

**Radarr** (re-grab flow only):
- `radarr_replace_movie(tmdbId, keepFile?)` — delete the existing file (unless `keepFile`) and trigger a fresh `MoviesSearch`; **mutating**

**Sonarr** (re-grab flow only):
- `sonarr_replace(tmdbId, seasonNumber, episodeNumber?, keepFile?)` — delete the existing file(s) and trigger `EpisodeSearch` or `SeasonSearch`; **mutating**

**Confirmation gate** (not a tool the model can call — built into the harness):
- Every mutating tool — `overseerr_create_request`, `radarr_replace_movie`, `sonarr_replace`, `plex_apply_match` — triggers a CLI prompt before execution. Agent presents a plan, user types `y` or `N`, harness either executes or returns "user declined" to the agent.

## 6. Skills (v1)

Four skills, each focused. The agent picks which to load when based on the description frontmatter.

| Skill | When | What it teaches the agent |
|---|---|---|
| `taste-profile` | Any recommendation query | How to build a profile from `plex_library` + `plex_history` + `plex_ratings`: weighting recent watches, identifying director/genre clusters, handling sparse data |
| `recommend-watch` | "What should I watch tonight" / mood queries | How to match the profile against existing-library candidates first, then fall back to discovery for things to request |
| `find-and-add` | "Find me X" → request flow | How to compose `overseerr_search` results, deduplicate, propose a confirmation plan |
| `library-audit` | "What's stale" / library stats queries | How to summarize library state: oldest unwatched, biggest unwatched genres, top-watched directors, completion gaps |

Each `SKILL.md` has YAML frontmatter (`name`, `description`) plus the body of instructions. Bodies load on-demand — progressive disclosure keeps token usage reasonable.

## 7. Confirmation discipline

Mutations require explicit user confirmation. The harness intercepts `overseerr_create_request` calls and prompts:

```
About to create 3 Overseerr requests:
  • Arrival 2.0 (2026) — movie
  • Foe (2025) — movie
  • The Substance (2024) — movie
Proceed? [y/N]
```

User types `y` → calls execute and results returned to the agent. User types anything else → all three skipped, `{ declined: true }` returned to the agent so it can adjust.

**Override:** `--yolo` flag on launch disables the confirmation gate. Use at your own risk.

## 8. File layout

```
rt2/
  .env.example
  package.json
  tsconfig.json
  README.md             setup, Plex-token retrieval, mdblist API key, examples
  PRD.md                this file
  src/
    index.ts            CLI entry, flag parsing, launches REPL
    repl.ts             readline + streaming-query loop, surfaces tool/skill activity
    agent.ts            SDK config: model, tools, skills directory, system prompt
    confirm.ts          confirmation-gate interceptor for mutating tools
    logger.ts           TTY-aware structured logging
    tools/
      overseerr.ts      Overseerr/Seerr client + tool definitions
      plex.ts           Plex client + tool definitions
    prompts/
      system.md         base system prompt
  skills/
    taste-profile/SKILL.md
    recommend-watch/SKILL.md
    find-and-add/SKILL.md
    library-audit/SKILL.md
  logs/                 gitignored — session transcripts
```

## 9. Configuration

`.env` (gitignored):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API auth |
| `OVERSEERR_URL` | e.g. `https://overseerr.example.com` (no trailing slash) |
| `OVERSEERR_API_KEY` | Overseerr Settings → General → API Key |
| `PLEX_URL` | e.g. `http://plex.local:32400` |
| `PLEX_TOKEN` | X-Plex-Token (README documents how to get) |
| `MDBLIST_API_KEY` | mdblist.com → profile → API Key (optional; ratings disabled if unset) |
| `RADARR_URL` | e.g. `http://radarr.local:7878` (optional; enables `radarr_replace_movie`) |
| `RADARR_API_KEY` | Radarr → Settings → General → API Key (optional) |
| `SONARR_URL` | e.g. `http://sonarr.local:8989` (optional; enables `sonarr_replace`) |
| `SONARR_API_KEY` | Sonarr → Settings → General → API Key (optional) |

Boot sequence validates every credential before opening the REPL. If any service is unreachable or unauthorized, exit with a clear message naming the offending var.

## 10. CLI interface

```
media-agent [options]

Options:
  --yolo               Disable confirmation gating on mutating tools (default: off)
  --log-level LEVEL    debug|info|warn|error (default: info)
  --transcript PATH    Save the session transcript to a file (default: logs/session-<ts>.log)
```

No subcommands. Everything happens through the REPL.

## 11. Open / deferred decisions

- Exact TS Agent SDK API for loading a skills directory — verify against current SDK version at build time.
- **v2 candidates:** Tautulli for richer stats, Sonarr/Radarr direct, persistent multi-session memory, Trakt integration, scheduled headless mode (`media-agent run "<query>"` for cron), web UI.

## 12. Acceptance criteria

- `media-agent` launches, validates all configured services, opens a REPL prompt.
- Each of the five example queries in §3 produces a useful response.
- At least one skill is invoked during a typical recommendation session (verifiable via the surfaced `[loading skill]` line).
- `overseerr_create_request` always triggers a confirmation prompt unless `--yolo` is set.
- Ctrl-D or `exit` closes the REPL cleanly; transcripts are saved.
- All API failures (Overseerr down, Plex unreachable, mdblist 429) are reported to the agent with clear errors, not crashes — the agent should recover gracefully and continue the conversation.
