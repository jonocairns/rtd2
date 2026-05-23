import { evalite } from 'evalite';
import { createScorer } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { agentColumns } from './_columns.js';

const lookupRoutes = [
  route('GET', '/api/v1/search', {
    json: {
      results: [
        {
          id: 95396,
          mediaType: 'tv',
          name: 'Severance',
          firstAirDate: '2022-02-18',
          mediaInfo: { status: 5 },
        },
      ],
    },
  }),
  route('GET', '/api/v1/tv/95396', { json: { externalIds: { tvdbId: 371980 } } }),
  route('GET', '/api/v3/series?tvdbId=371980', {
    json: [{ id: 11, title: 'Severance', tvdbId: 371980 }],
  }),
  route('GET', '/api/v3/episode?seriesId=11', {
    json: [
      { id: 101, seriesId: 11, seasonNumber: 1, episodeNumber: 1, episodeFileId: 501, hasFile: true },
      { id: 102, seriesId: 11, seasonNumber: 1, episodeNumber: 2, episodeFileId: 502, hasFile: true },
    ],
  }),
];

evalite('sonarr-replace-scope', {
  data: () => [
    {
      input: {
        prompt: 'Replace just Severance S1E2 with a better release.',
        routes: [
          ...lookupRoutes,
          route('DELETE', '/api/v3/episodefile/502', { json: {} }),
          route('POST', '/api/v3/command', { json: { id: 90, status: 'queued' } }),
        ],
        expectedEpisode: 2,
      },
    },
    {
      input: {
        prompt: 'Replace all of Severance season 1 with a better release.',
        routes: [
          ...lookupRoutes,
          route('DELETE', '/api/v3/episodefile/501', { json: {} }),
          route('DELETE', '/api/v3/episodefile/502', { json: {} }),
          route('POST', '/api/v3/command', { json: { id: 91, status: 'queued' } }),
        ],
        expectedEpisode: null,
      },
    },
  ],
  task: async (input) => runScenario(input as Parameters<typeof runScenario>[0]),
  scorers: [
    createScorer({
      name: 'uses sonarr_replace with correct scope',
      scorer: ({ input, output }) => {
        const expectedEpisode = (input as { expectedEpisode: number | null }).expectedEpisode;
        const call = output.toolCalls.find((c) => c.name === 'sonarr_replace');
        const args = call?.input as { tmdbId?: number; seasonNumber?: number; episodeNumber?: number } | undefined;
        const episodeOk =
          expectedEpisode === null
            ? args?.episodeNumber === undefined
            : args?.episodeNumber === expectedEpisode;
        return {
          score: args?.tmdbId === 95396 && args?.seasonNumber === 1 && episodeOk ? 1 : 0,
          metadata: { actual: call?.input ?? null, expectedEpisode },
        };
      },
    }),
  ],
  columns: agentColumns(),
});
