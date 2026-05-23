import { evalite } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { containsTools, finalTextIncludes, toolOrder, toolInputMatches } from './_scorers.js';
import { agentColumns } from './_columns.js';

evalite('plex-match-flow', {
  data: () => [
    {
      input: {
        prompt:
          'The Matrix is matched wrong in Plex. Search it, use the TMDb match for The Matrix (1999), and apply it.',
        routes: [
          route('GET', '/search', {
            json: {
              MediaContainer: {
                Hub: [
                  {
                    type: 'movie',
                    Metadata: [
                      {
                        ratingKey: '55555',
                        title: 'The Matrix',
                        type: 'movie',
                        year: 1999,
                        guid: 'plex://movie/wrong',
                      },
                    ],
                  },
                ],
              },
            },
          }),
          route('GET', '/library/metadata/55555/matches', {
            json: {
              MediaContainer: {
                SearchResult: [
                  {
                    guid: 'tmdb://603',
                    name: 'The Matrix',
                    year: 1999,
                  },
                ],
              },
            },
          }),
          route('PUT', '/library/metadata/55555/match', { json: {} }),
        ],
      },
    },
  ],
  task: async (input) => runScenario(input),
  scorers: [
    containsTools('plex_search', 'plex_get_matches', 'plex_apply_match'),
    toolOrder('plex_search', 'plex_get_matches'),
    toolOrder('plex_get_matches', 'plex_apply_match'),
    toolInputMatches('plex_apply_match', (i) => {
      const args = i as { ratingKey?: string; guid?: string };
      return args.ratingKey === '55555' && args.guid === 'tmdb://603';
    }),
    finalTextIncludes('tmdb://603'),
  ],
  columns: agentColumns(),
});
