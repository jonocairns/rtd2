# Runtime Migration Plan

## Goal

Move the media agent off the Claude Agent SDK while staying useful as a local Plex / Overseerr / Radarr / Sonarr assistant.

The first step is Vercel AI SDK Core: it gives the project a vendor-neutral model/tool loop with lower migration risk. Mastra remains a later learning/framework option now that the tool surface is no longer coupled to the Claude Agent SDK.

## Current State

- `src/cli/agent.ts` owns the AI SDK model loop, tool registration, and system prompt.
- `src/cli/model.ts` owns provider selection.
- `src/tools/*` exports local neutral tool descriptors plus service-specific helper functions.
- `src/clients/*` owns reusable service/client logic that should not import agent or CLI code.
- `src/mcp/server.ts` exposes the tool registry over MCP stdio.
- `src/cli/repl.tsx` owns the CLI loop, spinner, streaming output rendering, tool-call display, and token usage display.
- `src/confirm.ts` gates mutating tools before execution and writes approval decisions to the audit log.
- `src/audit.ts` records session, tool-call, and confirmation events.

The useful boundaries are already in place: service logic is mostly isolated in `src/tools/*`, and the REPL is separate from model configuration. The migration should preserve those boundaries.

## Target Shape

Proposed structure:

```text
src/
  cli/
    agent.ts          provider-agnostic model loop
    model.ts          provider/model selection
    repl.tsx          CLI loop calling the runtime stream
  clients/            reusable service clients
  tools/              tool descriptors and shared result formatting
  mcp/                MCP stdio adapter
  workflows/          deterministic cross-service flows
```

The long-term direction is:

- Vercel AI SDK owns the first provider-agnostic model/tool loop.
- Service modules keep HTTP/API logic.
- Mutating tools keep the existing CLI approval gate.
- The CLI remains a thin local interface.
- Mastra or another orchestration layer can be added later without another provider migration.

## Migration Steps

### 1. Add AI SDK Runtime

- Add `ai`, `@ai-sdk/openai`, and `@ai-sdk/anthropic`.
- Replace Claude `query()` with AI SDK `streamText()`.
- Support `MODEL_PROVIDER` and `MODEL_NAME`.
- Preserve the current CLI spinner, tool-call display, confirmation gate, and audit logging.

### 2. Decouple Tool Definitions

- Done: `src/tools/define.ts` provides a local descriptor helper.
- Done: the Claude Agent SDK package has been removed.
- Remaining: split larger service implementations from descriptor exports where that improves testability.

### 3. Tighten Runtime Behavior

- Make token cost display provider/model-aware.
- Add focused tests for the runtime adapter with a mocked model/tool loop.
- Update eval expectations if provider behavior differs from Claude.

### 4. Optional Mastra Layer

After the AI SDK migration is stable, consider Mastra for:

- enable Mastra local Studio for inspecting agent runs
- add memory for session continuity
- model selected workflows explicitly, such as "quality issue -> report issue -> offer re-grab"
- extend the existing MCP server with richer approval/token flows
- add evals around the new agent/tool loop

## Provider Strategy

```text
MODEL_PROVIDER=openai
MODEL_NAME=gpt-5.2
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

Provider choice should be explicit and easy to change. The runtime must not bake provider assumptions into service tools or the REPL.

## Risks

- Streaming event shapes do not map one-for-one to the old Claude SDK messages.
- Token usage accounting may need to change or become provider-dependent.
- Existing eval baselines may shift when run against OpenAI models.

## Acceptance Criteria

- `pnpm typecheck` passes.
- `pnpm test` passes.
- The REPL can answer a read-only library/search prompt through AI SDK.
- The REPL shows loading state immediately after prompt submission.
- Tool calls are visible in the CLI as they happen.
- Mutating tools still require confirmation unless `--yolo` or an equivalent explicit bypass is enabled.
- Audit logs still include tool calls and approval decisions.
- README setup instructions describe the new provider/model configuration.
