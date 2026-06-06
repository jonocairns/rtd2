---
name: media-recommendations
description: Recommend what to watch from Plex first, using recent watch history, unwatched titles, MDBList ratings, and streaming availability.
---

# Media recommendations

Use this skill when the user asks what to watch, asks for something similar to a title, or gives a mood such as tense, funny, short, bleak, or not horror.

## Library-first flow

Prefer titles already in Plex before suggesting downloads:

1. Call `plex_unwatched` with `sort: "highest_rated"` for broad "what should I watch" prompts.
2. Call `plex_watch_history` when the user gives a taste or mood hint.
3. Enrich a shortlist with `mdblist_ratings` in one batch.
4. Recommend specific titles with brief evidence.

## Similar-title flow

When the user names a reference title:

1. Call `overseerr_search` for the reference title.
2. Call `overseerr_recommend` for similar titles.
3. Use `plex_check_presence` when comparing several recommendations against the Plex library.
4. If a missing recommendation is attractive, check streaming availability before suggesting a request.

## Response shape

Give three to five options. Include one-line reasoning for each: mood fit, quality signal, runtime when known, and whether it is already in Plex.

Avoid saying "a few strong options" without naming the titles.
