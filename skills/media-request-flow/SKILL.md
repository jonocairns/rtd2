---
name: media-request-flow
description: Safely search, request, approve, reject, delete, or triage Overseerr/Seerr requests with Plex and streaming checks.
---

# Media request flow

Use this skill when the user wants to add, request, approve, reject, delete, or triage titles in Overseerr/Seerr.

## Search before mutation

Always resolve named titles through `overseerr_search` before creating requests. Use the result's `tmdbId`, `mediaType`, year, and library status to avoid acting on the wrong title.

If the title is already available, pending, processing, or partially available, say so and do not request it again.

## Streaming check

When the user asks where something is available, or asks whether they should request it, call `overseerr_watch_providers` before recommending a download. Library status and streaming availability are different facts.

## TV season scope

For TV requests, ask which seasons the user wants unless they already specified season scope. Do not request every season by default.

## Request management

Use:

- `overseerr_list_requests` to find request IDs.
- `overseerr_get_request` for detailed status or download progress.
- `overseerr_approve_request`, `overseerr_reject_request`, or `overseerr_delete_request` only after the request ID is grounded in tool output.

## Safety

Mutating calls should go through the runtime's approval mechanism. In MCP mode, mutating tools are blocked unless the MCP server is explicitly launched with mutation support.
