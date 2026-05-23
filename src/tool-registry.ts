import {
  overseerr_search,
  overseerr_search_person,
  overseerr_person_credits,
  overseerr_watch_providers,
  overseerr_get_quota,
  overseerr_list_requests,
  overseerr_get_request,
  overseerr_create_request,
  overseerr_cancel_request,
  overseerr_delete_request,
  overseerr_approve_request,
  overseerr_reject_request,
  overseerr_recommend,
  overseerr_trending,
  overseerr_discover,
  overseerr_report_issue,
} from './tools/overseerr.js';
import { mdblist_ratings } from './tools/mdblist.js';
import {
  plex_recently_added,
  plex_watch_history,
  plex_unwatched,
  plex_search,
  plex_get_matches,
  plex_apply_match,
} from './tools/plex.js';
import { radarr_replace_movie, radarr_delete_movie } from './tools/radarr.js';
import { sonarr_replace, sonarr_delete_series } from './tools/sonarr.js';
import type { RuntimeTool } from './tool-runtime.js';

export const baseToolDescriptors = [
  overseerr_search,
  overseerr_search_person,
  overseerr_person_credits,
  overseerr_watch_providers,
  overseerr_get_quota,
  overseerr_list_requests,
  overseerr_get_request,
  overseerr_create_request,
  overseerr_cancel_request,
  overseerr_delete_request,
  overseerr_approve_request,
  overseerr_reject_request,
  overseerr_recommend,
  overseerr_trending,
  overseerr_discover,
  overseerr_report_issue,
  mdblist_ratings,
  plex_recently_added,
  plex_watch_history,
  plex_unwatched,
  plex_search,
  plex_get_matches,
  plex_apply_match,
  radarr_replace_movie,
  radarr_delete_movie,
  sonarr_replace,
  sonarr_delete_series,
] as RuntimeTool[];

export const readOnlyToolDescriptors = baseToolDescriptors.filter(
  (descriptor) => descriptor.annotations?.readOnlyHint
);
