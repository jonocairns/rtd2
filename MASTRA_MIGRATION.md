# Mastra Migration Plan

## Goal

Move the media agent from the Claude Agent SDK to Mastra so the project can be used as a learning tool for TypeScript agent architecture while staying useful as a local Plex / Overseerr / Radarr / Sonarr assistant.

This is not just a provider swap. The current app is a small CLI harness around Claude's Agent SDK. Mastra gives the project a broader agent framework to learn from: agents, typed tools, streaming, tool approval, workflows, memory, observability, local Studio, and optional MCP exposure.

## Current State

- `src/agent.ts` owns the Claude Agent SDK setup, model choice, MCP server creation, tool registration, and system prompt.
- `src/tools/*` exports Claude SDK `tool(...)` definitions plus service-specific helper functions.
- `src/repl.ts` owns the CLI loop, spinner, streaming output rendering, tool-call display, and token usage display.
- `src/confirm.ts` gates mutating tools before execution and writes approval decisions to the audit log.
- `src/audit.ts` records session, tool-call, and confirmation events.

The useful boundaries are already in place: service logic is mostly isolated in `src/tools/*`, and the REPL is separate from model configuration. The migration should preserve those boundaries.

## Target Shape

Proposed structure:

```text
src/
  mastra/
    index.ts          Mastra registry
    agent.ts          media agent config and system prompt
    tools/           Mastra createTool wrappers
    approvals.ts     approval policy / CLI bridge if needed
  tools/             service clients and shared result formatting
  repl.ts            CLI loop calling the Mastra agent stream
```

The long-term direction is:

- Mastra owns agent orchestration.
- Mastra `createTool` owns tool schemas and execution wrappers.
- Service modules keep HTTP/API logic.
- Mutating tools use Mastra approval where possible.
- The CLI remains a thin local interface.
- MCP export is optional after the local Mastra agent works.

## Migration Steps

### 1. Add Mastra Skeleton

- Add Mastra dependencies.
- Create `src/mastra/agent.ts` with the existing system prompt moved from `src/agent.ts`.
- Create `src/mastra/index.ts` with a `Mastra` registry and one media agent.
- Keep the current Claude path working until the first Mastra path is verified.

### 2. Convert One Read-Only Tool

Start with `overseerr_search`.

- Split the service implementation from the Claude SDK wrapper if needed.
- Add a Mastra `createTool` wrapper with the same input schema and description.
- Verify the agent can call it and answer a simple title-search prompt.

This step proves model, tool schema, tool execution, and stream handling before touching mutating operations.

### 3. Wire The REPL To Mastra Streaming

- Replace `run({ prompt, canUseTool })` with a Mastra-backed stream adapter.
- Preserve existing UI behavior:
  - spinner starts immediately after user input
  - tool calls are printed as they happen
  - text streams or renders cleanly
  - prompt is not re-opened until the assistant turn is complete
  - audit log still records tool calls

Token usage display may need to be adjusted depending on what Mastra exposes for the selected model/provider.

### 4. Convert Remaining Read-Only Tools

Convert:

- `overseerr_search_person`
- `overseerr_person_credits`
- `overseerr_watch_providers`
- `overseerr_get_quota`
- `overseerr_list_requests`
- `overseerr_get_request`
- `overseerr_recommend`
- `overseerr_trending`
- `mdblist_ratings`
- `plex_recently_added`
- `plex_watch_history`
- `plex_unwatched`
- `plex_search`
- `plex_get_matches`

Keep the system prompt tool names stable unless there is a strong reason to rename them.

### 5. Convert Mutating Tools With Approval

Convert:

- `overseerr_create_request`
- `overseerr_cancel_request`
- `overseerr_report_issue`
- `radarr_replace_movie`
- `sonarr_replace`
- `plex_apply_match`

The current confirmation behavior should be preserved:

- resolve a human-readable subject before asking
- show exactly what will happen
- default to decline
- record the decision in the audit log
- return a useful denial result to the agent when declined

Prefer Mastra's tool approval mechanism if it can support the current CLI prompt flow cleanly. If not, keep a small local approval wrapper around mutating tool execution and revisit later.

### 6. Remove Claude-Specific Runtime

Once all tools and the REPL are on Mastra:

- remove `@anthropic-ai/claude-agent-sdk`
- remove Claude SDK imports from tool modules
- replace `ANTHROPIC_API_KEY` as the only required model credential
- update `README.md`, `PRD.md`, and `.env.example`

The app should support a configurable model/provider rather than hard-coding one vendor.

### 7. Add Learning Features

After parity:

- enable Mastra local Studio for inspecting agent runs
- add memory for session continuity
- model selected workflows explicitly, such as "quality issue -> report issue -> offer re-grab"
- expose the media tools as an MCP server
- add evals around the new agent/tool loop

## Provider Strategy

Mastra should be configured so provider choice is explicit and easy to change. The first migration can use whatever provider is easiest to get working, but the final shape should not bake provider assumptions into service tools or the REPL.

Suggested environment variables:

```text
MODEL_PROVIDER=openai
MODEL_NAME=gpt-5.2
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

Exact model names and provider package setup should be verified against current Mastra docs during implementation.

## Risks

- Streaming event shapes may not map one-for-one to the current Claude SDK messages.
- Token usage accounting may need to change or become provider-dependent.
- Built-in Mastra approval may not perfectly match the current CLI confirmation flow.
- Tool schemas may need small changes if Mastra expects different schema metadata.
- Existing evals exercise the real Claude API path and will need a new runner.

## Acceptance Criteria

- `pnpm typecheck` passes.
- `pnpm test` passes.
- The REPL can answer a read-only library/search prompt through Mastra.
- The REPL shows loading state immediately after prompt submission.
- Tool calls are visible in the CLI as they happen.
- Mutating tools still require confirmation unless `--yolo` or an equivalent explicit bypass is enabled.
- Audit logs still include tool calls and approval decisions.
- README setup instructions describe the new provider/model configuration.

