import { evalite } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { containsTools, toolOrder, toolInputMatches } from './_scorers.js';
import { agentColumns } from './_columns.js';

evalite('search-and-request', {
  data: () => [
    {
      input: {
        prompt: 'Please request The Matrix.',
        routes: [
          route('GET', '/api/v1/auth/me', { json: {} }),
          route('GET', '/api/v1/search', {
            json: {
              results: [
                {
                  id: 603,
                  mediaType: 'movie',
                  title: 'The Matrix',
                  releaseDate: '1999-03-30',
                  mediaInfo: null,
                },
              ],
            },
          }),
          route('POST', '/api/v1/request', { json: { id: 1234, status: 2 } }),
        ],
      },
    },
  ],
  task: async (input) => runScenario(input),
  scorers: [
    containsTools('overseerr_search', 'overseerr_create_request'),
    toolOrder('overseerr_search', 'overseerr_create_request'),
    toolInputMatches('overseerr_create_request', (i) => {
      const args = i as { tmdbId?: number; mediaType?: string };
      return args.tmdbId === 603 && args.mediaType === 'movie';
    }),
  ],
  columns: agentColumns(),
});
