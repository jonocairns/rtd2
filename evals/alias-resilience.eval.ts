import { evalite } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { containsTools, finalTextIncludes, toolInputMatches } from './_scorers.js';
import { agentColumns } from './_columns.js';

evalite('alias-resilience', {
  data: () => [
    {
      input: {
        prompt: 'Show me unwatched series sorted by top rated.',
        routes: [
          route('GET', '/library/sections/2/unwatched', {
            json: {
              MediaContainer: {
                Metadata: [
                  {
                    title: 'Severance',
                    type: 'show',
                    year: 2022,
                    audienceRating: 9.1,
                  },
                ],
              },
            },
          }),
          route('GET', '/library/sections', {
            json: {
              MediaContainer: {
                Directory: [
                  { key: '1', type: 'movie', title: 'Movies' },
                  { key: '2', type: 'show', title: 'TV Shows' },
                ],
              },
            },
          }),
        ],
      },
    },
  ],
  task: async (input) => runScenario(input),
  scorers: [
    containsTools('plex_unwatched'),
    toolInputMatches('plex_unwatched', (i) => {
      const args = i as { section?: string; sort?: string };
      return (
        ['shows', 'show', 'series', 'tv'].includes(args.section ?? '') &&
        ['highest_rated', 'top_rated'].includes(args.sort ?? '')
      );
    }),
    finalTextIncludes('Severance'),
  ],
  columns: agentColumns(),
});
