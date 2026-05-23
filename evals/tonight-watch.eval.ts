import { evalite } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { containsTools, finalTextIncludesAny } from './_scorers.js';
import { agentColumns } from './_columns.js';

evalite('tonight-watch', {
  data: () => [
    {
      input: {
        prompt: "What should I watch tonight? Surprise me with something good I haven't seen.",
        routes: [
          // More specific route first; runner uses Array.find().
          route('GET', '/library/sections/1/unwatched', {
            json: {
              MediaContainer: {
                Metadata: [
                  {
                    title: 'Past Lives',
                    type: 'movie',
                    year: 2023,
                    addedAt: 1700000000,
                    audienceRating: 8.4,
                  },
                  {
                    title: 'Aftersun',
                    type: 'movie',
                    year: 2022,
                    addedAt: 1700000000,
                    audienceRating: 7.8,
                  },
                ],
              },
            },
          }),
          route('GET', '/library/sections', {
            json: {
              MediaContainer: {
                Directory: [{ key: '1', type: 'movie', title: 'Movies' }],
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
    finalTextIncludesAny('Past Lives', 'Aftersun'),
  ],
  columns: agentColumns(),
});
