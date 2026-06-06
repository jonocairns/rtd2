---
name: media-list-gaps
description: Compare curated MDBList lists against Plex to find missing titles, optionally applying ratings thresholds before checking presence.
---

# Media list gaps

Use this skill when the user asks what they are missing from a curated list, MDBList URL, watchlist, genre list, director list, or a large title set.

## Preferred tool flow

1. Call `mdblist_list` with the full URL or `user/slug` shorthand.
2. If the user gave rating thresholds, pass `ratingsFilter` directly to `mdblist_list` so the list is filtered before it reaches the model context.
3. Pass the returned `items` to `plex_check_presence` in one batch. Prefer `tmdbId`, then `imdbId`, then `tvdbId`, with `title` + `year` as fallback.
4. Use `returnOnly: "missing"` when the user only cares about gaps.

Do not loop `plex_search` for every title in a list. `plex_check_presence` loads the library once and diffs in-process.

## Reporting

Summarize counts first:

```text
17/64 present, 47 missing in Plex.
```

Then show the best missing titles, not the whole raw list unless the user asks. Include title, year, rating evidence if available, and identifiers when useful.

## Request follow-up

If the user wants to request missing titles, search each selected title with `overseerr_search` before requesting. Use `overseerr_create_request` only after the selected title is resolved to a specific TMDb id and media type.
