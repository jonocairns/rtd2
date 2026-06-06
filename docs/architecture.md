# Architecture

RTD2 is organized around reusable media operations rather than a single custom agent loop.

## Boundaries

```text
skills -> describe workflow strategy for Claude/Codex
mcp    -> exposes tools to external hosts
tools  -> validate inputs, format outputs, enforce idempotency/safety
clients -> talk to Plex, MDBList, Overseerr, Radarr, Sonarr
cli    -> optional terminal agent harness
```

## Rules

- Client modules should not import agent, CLI, MCP, or prompt code.
- Tool modules can import clients, `env`, idempotency, and output helpers.
- Skills should contain workflow guidance only; do not hide executable logic in skills.
- Mutating operations need an approval surface. The CLI provides one. MCP blocks mutations by default unless launched with `MCP_ALLOW_MUTATIONS=1`.
- Deterministic multi-step logic that becomes repeated should move into `src/workflows`.

## Current Extraction

- `src/clients/mdblist/client.ts` owns MDBList list parsing, batched ratings calls, and score filtering.
- `src/clients/plex/client.ts` owns Plex section loading, library indexing, and batch presence checks.
- `src/workflows/list-gaps.ts` composes those clients for curated-list gap checks.
- `src/cli/*` contains the old Ink/AI SDK terminal harness.
- `src/mcp/server.ts` exposes the existing tool registry over MCP stdio.
