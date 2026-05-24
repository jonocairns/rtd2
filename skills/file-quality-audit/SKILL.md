---
name: file-quality-audit
description: Inspect Plex file quality metadata to find low-quality downloads by container, video codec, resolution, bitrate, file size, and audio tracks, then propose safe Radarr/Sonarr follow-up actions.
---

# File quality audit

Use this skill when the user asks which Plex titles look low quality, asks for files by codec/container/resolution, or wants evidence before replacing a download.

## Data source

Prefer Plex for inspection because it reports the actual library file metadata:

- `plex_quality_audit` for broad audits across movies, shows, or all libraries.
- `plex_search` -> `plex_quality_profile` for one named title.

Use Radarr/Sonarr only after Plex has identified a concrete bad file and the user wants a replacement. Radarr/Sonarr are action systems here, not the primary source of stream metadata.

## Audit defaults

If the user says "low quality" without thresholds:

- Start with `plex_quality_audit({ section: "movies", minHeight: 1080 })`.
- For TV, use `section: "shows"`; Plex audits episode files using `type=4`.
- If the user cares about modern efficient encodes, pass `preferredVideoCodecs: ["hevc", "av1"]`.
- If the user cares about containers, pass `preferredContainers: ["mkv", "mp4"]` or the exact set they named.
- If the user gives size or bitrate cutoffs, pass `maxFileSizeGiB` or `minBitrateKbps`.

Do not assume H.264 is bad by itself. Treat it as a preference mismatch only when the user asks for HEVC/AV1 or modern encodes.

## Interpreting results

Summarize the worst items first. Include enough evidence for each item:

- Title or episode.
- Resolution.
- Video codec.
- Container.
- Bitrate if present.
- File size if present.
- Audio tracks in compact form, especially channel count/layout and codec.
- Flags returned by the tool.

Do not overstate fields Plex did not report. Say "not reported" rather than guessing.

## Follow-up actions

Quality inspection is read-only. If the user wants to replace files:

- For movies, use `overseerr_search` to get the TMDb ID, then `radarr_replacement_candidates` before `radarr_replace_movie`.
- For TV, use `overseerr_search` to get the TMDb ID, then `sonarr_replace` with the exact season and episode from the audit item.
- State the specific file/title/episode evidence before calling a mutating replacement tool.
- If Radarr's top scored candidate is below the current/default quality floor, do not call `radarr_replace_movie` unless the user explicitly accepts that downgrade.
- If Radarr's top scored candidate is poor but another candidate is better, recommend one candidate with a short reason using its quality, size, score, age, indexer, and title. After the user authorizes that recommendation, call `radarr_replace_movie` with `selectedReleaseGuid` and `selectedReleaseIndexerId`.
- Let the normal confirmation gate handle approval.

When showing replacement choices, use radio-style lines:

```text
(•) Recommended: 1080p BluRay, 14.9 GiB, score +400 — better quality floor match
( ) Automatic top: DVD, 833.9 MiB, score +20000 — profile score is high but quality is lower
( ) Skip replacement for now
```

Keep each option to one line where possible.

For yes/no choices about deletion or replacement, show No as the selected default unless the user already asked for that exact action:

```text
( ) Yes, delete the current file and grab the recommended release
(•) No, leave the current file in place
```
