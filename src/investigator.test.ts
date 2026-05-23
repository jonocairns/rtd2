import { describe, expect, it } from 'vitest';
import { media_investigate } from './investigator.js';
import { readOnlyToolDescriptors } from './tool-registry.js';

const mutatingTools = new Set([
  'overseerr_create_request',
  'overseerr_cancel_request',
  'overseerr_delete_request',
  'overseerr_approve_request',
  'overseerr_reject_request',
  'overseerr_report_issue',
  'plex_apply_match',
  'radarr_replace_movie',
  'radarr_delete_movie',
  'sonarr_replace',
  'sonarr_delete_series',
]);

describe('media investigator guardrails', () => {
  it('is exposed as a read-only tool', () => {
    expect(media_investigate.annotations?.readOnlyHint).toBe(true);
  });

  it('only receives read-only tools', () => {
    expect(readOnlyToolDescriptors.length).toBeGreaterThan(0);
    for (const descriptor of readOnlyToolDescriptors) {
      expect(descriptor.annotations?.readOnlyHint).toBe(true);
      expect(mutatingTools.has(descriptor.name)).toBe(false);
    }
  });
});
