# RTD2

A terminal agent for managing a Plex library backed by Overseerr, Radarr, Sonarr, and mdblist.

It can find things to watch, inspect low-quality downloads, re-grab bad files, fix Plex matches, and manage requests. Destructive actions go through a confirmation prompt.

![media-agent CLI](rtd2.png)

## Prompts

```text
find low-quality movie files and show me the best upgrade candidates before deleting anything
```

```text
check Severance season 1 for missing or low-quality episodes, then tell me whether to run a season search or fix episodes one by one
```

```text
what should I watch tonight from my unwatched library, something tense but not horror?
```

```text
request The Insider if it is not already in my library or pending
```

```text
what am I missing by David Fincher?
```

```text
where can I stream Anatomy of a Fall before I request it?
```

```text
show me pending requests and approve the good ones
```

```text
this Plex match is wrong for Solaris, show me the alternate matches before changing it
```

```text
sync my mdblist watchlist with Overseerr
```

```text
what was recently added to Plex that I have not watched yet?
```

```text
show me my recent watch history and recommend something similar from the library
```

```text
find highly rated sci-fi movies I am missing
```

```text
how many requests do I have left this month?
```

```text
report a video quality issue for Gods and Monsters, then show the safest regrab options
```

```text
remove this bad Radarr movie entry but keep the file on disk
```

```text
any requests from last month that still have not downloaded?
```

```text
what is in my library by Denis Villeneuve, and which of his am I missing?
```

```text
my library is getting huge, what unwatched stuff looks safe to prune?
```

```text
add Dune: Part Three when it is available
```

## Getting Started

```bash
nix develop
pnpm install
cp .env.example .env
$EDITOR .env
# fill in the env
pnpm dev
```

Useful commands:

```bash
pnpm test
pnpm typecheck
pnpm build
```
