# media-agent

A REPL-based AI agent for managing a self-hosted media setup (Plex + Overseerr/Seerr + mdblist), built on Vercel AI SDK Core.

See [PRD.md](PRD.md) for the full design.

## Setup

This project uses [Nix flakes](https://nixos.wiki/wiki/Flakes) for the dev environment and [pnpm](https://pnpm.io/) for package management.

### 1. Enter the dev shell

```bash
nix develop
```

Or if you have [direnv](https://direnv.net/) installed, just `cd` into the directory and `direnv allow` once — the included `.envrc` will load the flake automatically.

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure credentials

```bash
cp .env.example .env
$EDITOR .env
```

How to obtain each credential:

| Variable | How to get it |
|---|---|
| `MODEL_PROVIDER` | `openai` or `anthropic`; defaults to OpenAI when `OPENAI_API_KEY` is set |
| `MODEL_NAME` | Optional model override; defaults to `gpt-5.2` for OpenAI or `claude-sonnet-4-6` for Anthropic |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) → API keys |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys; required when `MODEL_PROVIDER=anthropic` |
| `OVERSEERR_API_KEY` | Overseerr/Seerr UI → Settings → General → API Key |
| `PLEX_URL` | Your Plex server URL — local typically `http://<host>:32400` |
| `PLEX_TOKEN` | See the [Plex docs](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) — easiest method is browser dev tools while logged into Plex Web |
| `MDBLIST_API_KEY` | [mdblist.com](https://mdblist.com) → your profile → API Key |

### 4. Run

```bash
pnpm dev          # development (tsx, no build step)
pnpm build        # compile to dist/
pnpm start        # run compiled
pnpm typecheck    # type-check src + tests + evals
pnpm test         # run unit tests (vitest, mocked fetch)
pnpm eval         # run scripted-conversation evals once (hits the configured model provider, costs API credits)
pnpm eval:ui      # serve the evalite UI against existing run history (no new run, no API spend)
```

Evals run via [evalite](https://www.npmjs.com/package/evalite) and need a real model provider API key in `.env` or the shell. The runner mocks Plex/Overseerr/Radarr/Sonarr but lets the configured model API through, so each scenario is a genuine model invocation. Run history is persisted at `node_modules/.evalite/cache.sqlite`.

First run only: `pnpm approve-builds` and accept `better-sqlite3` (evalite's storage backend). See [GUARDRAILS.md §7](GUARDRAILS.md) for the design.

## Usage

Launch the REPL:

```bash
pnpm dev
```

Then talk to the agent about your library. Examples:

```
> what should I watch tonight, something like Severance but lighter?
> sync my mdblist rt-m into overseerr
> show me requests from last month that haven't downloaded yet
> what's in my library by Villeneuve?
```

The agent will ask for confirmation before making mutating changes. Pass `--yolo` to skip confirmation.

## Project structure

See [PRD.md §8](PRD.md#8-file-layout) for the full layout. Top level:

- `src/` — TypeScript source
- `skills/` — agent skills (markdown with YAML frontmatter)
- `flake.nix` — Nix dev shell definition
- `PRD.md` — product requirements / design doc
