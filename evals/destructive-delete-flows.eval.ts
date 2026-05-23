import { evalite } from 'evalite';
import { createScorer } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { agentColumns } from './_columns.js';

evalite('destructive-delete-flows', {
  data: () => [
    {
      input: {
        prompt: 'Remove The Matrix from Radarr entirely, but keep the file on disk.',
        routes: [
          route('GET', '/api/v1/search', {
            json: {
              results: [
                {
                  id: 603,
                  mediaType: 'movie',
                  title: 'The Matrix',
                  releaseDate: '1999-03-30',
                  mediaInfo: { status: 5 },
                },
              ],
            },
          }),
          route('GET', '/api/v3/movie?tmdbId=603', {
            json: [{ id: 42, title: 'The Matrix', year: 1999, tmdbId: 603, hasFile: true }],
          }),
          route('DELETE', '/api/v3/movie/42', { json: {} }),
        ],
        expectedTool: 'radarr_delete_movie',
        forbiddenTool: 'radarr_replace_movie',
      },
    },
    {
      input: {
        prompt: 'Remove Severance from Sonarr entirely, but do not delete files from disk.',
        routes: [
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
          route('DELETE', '/api/v3/series/11', { json: {} }),
        ],
        expectedTool: 'sonarr_delete_series',
        forbiddenTool: 'sonarr_replace',
      },
    },
  ],
  task: async (input) => runScenario(input),
  scorers: [
    createScorer({
      name: 'uses delete tool',
      scorer: ({ input, output }) => {
        const expected = (input as { expectedTool: string }).expectedTool;
        const names = output.toolCalls.map((c) => c.name);
        return { score: names.includes(expected) ? 1 : 0, metadata: { expected, names } };
      },
    }),
    createScorer({
      name: 'does not use replace tool',
      scorer: ({ input, output }) => {
        const forbidden = (input as { forbiddenTool: string }).forbiddenTool;
        const names = output.toolCalls.map((c) => c.name);
        return { score: names.includes(forbidden) ? 0 : 1, metadata: { forbidden, names } };
      },
    }),
  ],
  columns: agentColumns(),
});
