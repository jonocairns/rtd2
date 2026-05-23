import { evalite } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { containsTools, finalTextIncludes } from './_scorers.js';
import { agentColumns } from './_columns.js';

evalite('streaming-availability', {
  data: () => [
    {
      input: {
        prompt: 'Before I request Dune (2021), is it streaming anywhere I might already have?',
        routes: [
          route('GET', '/api/v1/search', {
            json: {
              results: [
                {
                  id: 438631,
                  mediaType: 'movie',
                  title: 'Dune',
                  releaseDate: '2021-10-22',
                  mediaInfo: null,
                },
              ],
            },
          }),
          route('GET', '/api/v1/movie/438631', {
            json: {
              id: 438631,
              title: 'Dune',
              watchProviders: [
                {
                  iso_3166_1: 'US',
                  link: 'https://example.com',
                  flatrate: [{ provider_id: 8, provider_name: 'Netflix' }],
                },
              ],
            },
          }),
        ],
      },
    },
  ],
  task: async (input) => runScenario(input),
  scorers: [
    containsTools('overseerr_watch_providers'),
    finalTextIncludes('Netflix'),
  ],
  columns: agentColumns(),
});
