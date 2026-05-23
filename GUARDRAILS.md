# Guardrails roadmap

Notes on hardening the agent's tool calls. Captures the current state, where 2026 best practice sits, and the prioritised work to close the gap. Companion to [PRD.md](PRD.md).

## What we already do

- **HITL on mutating tools.** `confirm.ts` gates `overseerr_create_request`, `radarr_replace_movie`, `sonarr_replace`, `plex_apply_match` behind a CLI prompt. Read-only tools run automatically.
- **Boot-time validation** of every configured backend (Overseerr, Radarr, Sonarr). Optional services skipped if unset.
- **Turn cap** of 30 in `agent.ts` — prevents runaway loops on a single user query.
- **Single-source env validation** in `env.ts` via zod; missing required vars fail loudly at startup.
- **System prompt invariants** — "always overseerr_search before requesting," "ask before requesting TV seasons," "consider watch_providers before suggesting a download."

## Gaps vs. 2026 best practice

Ordered by impact. Numbers below tie to PR-sized chunks.

### 1. Human-readable confirmation gate ✅

**Problem.** `confirm.ts` currently shows raw JSON args:

```
radarr_replace_movie
{ "tmdbId": 603 }
```

The user has no way to verify the agent picked the right title. If the model hallucinates an ID, "y" wipes the wrong movie.

**Fix.** Pre-flight resolution inside the gate. For each mutating tool, look up the human-readable subject before prompting:

```
About to replace in Radarr:
  The Matrix (1999)
  Current file: BluRay-1080p.mkv (12.4 GB)
  Action: delete file + queue MoviesSearch
Proceed? [y/N]
```

Per [HITL guidance](https://medium.com/@arvisionlab/human-in-the-loop-ai-agents-how-to-add-approvals-escalation-and-safe-autonomy-in-production-0a21e359781c), the approval surface must be human-readable, not a structured dump.

**Implemented.** Each mutating tool exports a `resolve*` function ([overseerr.ts](src/tools/overseerr.ts), [radarr.ts](src/tools/radarr.ts), [sonarr.ts](src/tools/sonarr.ts), [plex.ts](src/tools/plex.ts)) and [confirm.ts](src/confirm.ts) routes through a `RESOLVERS` registry — gate now shows title + year + current file before prompting. Falls back to raw JSON if the lookup itself fails.

### 2. Idempotency keys on every write

**Problem.** Models retry under uncertainty. A second `overseerr_create_request` for the same `tmdbId` while the first is in-flight creates a duplicate. The system prompt asks the agent to check first — that's not a guarantee, it's a hope.

**Fix.** Every mutating tool accepts an idempotency key (or derives one from `tool + tmdbId + operation`) and returns the prior result on duplicates. Per [Composio's 2026 integration guide](https://composio.dev/content/apis-ai-agents-integration-patterns): "tools must handle these patterns gracefully."

Practical shape: a small in-memory map keyed by `${tool}:${primaryId}` with a TTL of a few minutes, plus server-side dedup checks (e.g. `overseerr_list_requests` filter before `create_request`).

### 3. `isError: true` instead of throws ✅

**Problem.** `radarr.ts`, `sonarr.ts`, `plex.ts`, `overseerr.ts` all `throw new Error(...)` on API failures. The SDK surfaces those as exceptions, which can derail the agent loop instead of teaching it.

**Fix.** Convert API failures to structured returns:

```ts
return {
  content: [{ type: 'text', text: JSON.stringify({ error: '...', code: 404 }) }],
  isError: true,
};
```

Per [Anthropic's tool-use patterns](https://www.developersdigest.tech/blog/tool-use-claude-api-production-patterns): "the agent sees the error as data and can retry or adapt." Keep `throw` for truly unrecoverable cases (missing env, programmer errors).

**Implemented.** Shared [`safe()` wrapper](src/tools/errors.ts) wraps every tool handler across the five service modules. API failures become `isError: true` returns; the boot-time `requireConfig()` / env validation paths still throw on purpose.

### 4. Rate-limit aware fetch wrapper

**Problem.** None of the API wrappers respect `Retry-After` or 429 responses. A tight agent loop will eventually trip Plex or Overseerr rate limits and the run dies.

**Fix.** One shared `fetchWithBackoff(url, init, opts)` helper used by all four service modules. Exponential backoff + jitter, honours `Retry-After`, caps at 3 retries. Per the [orchestration anti-patterns roundup](https://www.digitalapplied.com/blog/agentic-workflow-anti-patterns-orchestration-mistakes-2026): "naïve retry" is a top-five failure mode.

### 5. Structured audit log ✅

**Problem.** PRD §10 mentions a `--transcript` flag; only visual `[bracket]` lines exist today. After a destructive operation goes wrong, there's no trace to read.

**Fix.** JSONL log alongside the visual REPL output:

```json
{ "ts": "2026-05-23T12:01:04Z", "tool": "radarr_replace_movie", "args": {...}, "resolved": "The Matrix (1999)", "outcome": "ok", "deleted": "..." }
```

One line per tool call. Easy to grep, easy to ship to a viewer later. Especially valuable for the four mutating tools.

**Implemented.** [`AuditLog`](src/audit.ts) writes JSONL to `logs/audit-<ts>.jsonl`. Events emitted: `session_start`, `tool_call` (from [repl.ts](src/repl.ts) when the agent invokes a tool), `confirm_decision` (from [confirm.ts](src/confirm.ts) with the resolved human-readable lines and approve/decline outcome).

### 6. Tighter tool output shapes ✅

**Problem.** Tools currently return raw `JSON.stringify(arr, null, 2)`. Big arrays push the agent toward token-bloated reasoning and dropped fields.

**Fix.** Adopt a consistent envelope:

```ts
{ summary: 'X movies, 3 missing', items: [...], nextSuggestedTool?: 'overseerr_create_request' }
```

Composio and Zylos both call this out: explicit contracts beat raw dumps. The `nextSuggestedTool` hint is optional but keeps multi-step flows on rails.

**Implemented.** Shared [`envelope()` helper](src/tools/output.ts) used by the 9 list-returning tools across [overseerr.ts](src/tools/overseerr.ts) and [plex.ts](src/tools/plex.ts). Output shape is now `{ summary, items, ...extras }` — e.g. `"5 titles, 2 missing from library"`. Skipped `nextSuggestedTool` (opinionated, error-prone) and skipped the already-structured detail/mutating tools.

### 7. Eval harness for the destructive flows ✅

**Problem.** No tests. A system-prompt tweak that breaks the issue-report→re-grab flow will only be caught by the user noticing during a real session.

**Fix.** Two layers:

- **Unit:** vitest with mocked `fetch`. Assert `radarr_replace_movie` calls `DELETE /moviefile/{id}` *before* `POST /command`, not after. Same for `sonarr_replace`. Cheap, high signal.
- **Eval:** ~10 scripted conversations checked into the repo (`evals/*.yaml`). Each fixes a system-prompt scenario + expected tool sequence. Run nightly or pre-PR. Per [the agent evaluation guide](https://medium.com/online-inference/ai-agent-evaluation-frameworks-strategies-and-best-practices-9dc3cfdf9890), metrics worth tracking: tool-selection accuracy, success rate per tool, error-recovery rate.

**Implemented.**

- **Unit:** vitest. Mocked-fetch helper at [src/tools/_testing.ts](src/tools/_testing.ts). Tests at [src/tools/*.test.ts](src/tools/) cover the `safe()` wrapper, the four mutating tools (call order, keepFile branches, error paths), and the envelope shape on a couple of read tools. 23 tests, runs in ~300ms. `pnpm test`.
- **Eval:** [evalite](https://www.npmjs.com/package/evalite) — TS-native eval runner with built-in run history (SQLite at `node_modules/.evalite/cache.sqlite`) and a local web UI for diffing across runs. Per-run cost is shown in a column, with rates pulled from [LiteLLM's pricing catalog](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) at startup so changing the model in [agent.ts](src/agent.ts) updates costs automatically; falls back to hardcoded Sonnet 4.x rates (marked with a `*`) when offline. [evals/_runner.ts](evals/_runner.ts) installs a host-aware fetch interceptor — backend hosts (overseerr.test, plex.test, radarr.test, sonarr.test, mdblist.com) are mocked; everything else (notably api.anthropic.com) passes through so the real Claude model is exercised. Reusable scorers in [evals/_scorers.ts](evals/_scorers.ts) (`containsTools`, `toolOrder`, `finalTextIncludes`, `toolInputMatches`). Five scenarios in [evals/](evals/): search-and-request, filmography-gap, issue-and-regrab, streaming-availability, tonight-watch. Run `pnpm eval` once (requires a real `ANTHROPIC_API_KEY`; costs API credits per run), `pnpm eval:ui` to see the run-history UI.

### 8. Self-check after destructive ops (optional)

**Problem.** Agent reports success based on the command-queue response, not the actual outcome.

**Fix.** After `radarr_replace_movie`, the agent re-fetches movie status and confirms `hasFile: false` + a queued grab is visible. This is the "agents that check their own output" pattern from [the Claude Agent SDK production guide](https://www.digitalapplied.com/blog/claude-agent-sdk-production-patterns-guide). Low-effort and catches silent failures.

## Out of scope for this codebase

- **Input-layer guardrails** (prompt-injection filters, jailbreak detection). Single-user CLI — you trust your own input.
- **Per-tenant cost caps.** Single user. `maxTurns` is enough.
- **Multi-layer defense (NeMo, Guardrails AI).** Overkill for the surface area.

## Recommended ordering

1, 2, 3 give the biggest reliability and safety jump for the least code. 4 and 5 are quality-of-life. 6 is housekeeping. 7 is the moat — it pays off the first time you tweak the system prompt and accidentally break a flow.

**Status:** 1, 3, 5, 6, 7 done. 2 deferred until we see real loop-retry behaviour in the wild. 4, 8 outstanding.

## Sources

- [AI Agent Guardrails: Production Guide for 2026 — Authority Partners](https://authoritypartners.com/insights/ai-agent-guardrails-production-guide-for-2026/)
- [Claude Agent SDK: Complete Production Patterns Guide 2026 — Digital Applied](https://www.digitalapplied.com/blog/claude-agent-sdk-production-patterns-guide)
- [Tool Use in the Claude API: Production Patterns for Reliable Agents — Developers Digest](https://www.developersdigest.tech/blog/tool-use-claude-api-production-patterns)
- [Human-in-the-Loop AI Agents: How to Add Approvals, Escalation, and Safe Autonomy in Production — Medium](https://medium.com/@arvisionlab/human-in-the-loop-ai-agents-how-to-add-approvals-escalation-and-safe-autonomy-in-production-0a21e359781c)
- [APIs for AI Agents: The 5 Integration Patterns (2026 Guide) — Composio](https://composio.dev/content/apis-ai-agents-integration-patterns)
- [Agentic Workflow Anti-Patterns: Orchestration Mistakes — Digital Applied](https://www.digitalapplied.com/blog/agentic-workflow-anti-patterns-orchestration-mistakes-2026)
- [Tool Use and Function Calling in AI Agents — Standards, Benchmarks, and Emerging Patterns — Zylos](https://zylos.ai/research/2026-04-07-tool-use-function-calling-standards-benchmarks)
- [AI Agent Evaluation: Frameworks, Strategies, and Best Practices — Medium](https://medium.com/online-inference/ai-agent-evaluation-frameworks-strategies-and-best-practices-9dc3cfdf9890)
