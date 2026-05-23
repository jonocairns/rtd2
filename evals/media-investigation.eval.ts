import { evalite } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { containsTools, finalTextIncludes } from './_scorers.js';
import { agentColumns } from './_columns.js';

evalite('media-investigation', {
  data: () => [
    {
      input: {
        prompt: 'Review my current Overseerr requests and tell me what needs attention.',
        routes: [
          route('GET', '/api/v1/request', {
            json: {
              results: [
                {
                  id: 4163,
                  status: 1,
                  createdAt: '2026-05-23T02:11:00Z',
                  updatedAt: '2026-05-23T02:11:00Z',
                  type: 'movie',
                  is4k: false,
                  media: { tmdbId: 11159, status: 2, mediaType: 'movie' },
                },
              ],
            },
          }),
          route('GET', '/api/v1/movie/11159', {
            json: { title: 'The Last Detail', releaseDate: '1973-12-12' },
          }),
        ],
      },
    },
  ],
  task: async (input) => runScenario(input as Parameters<typeof runScenario>[0]),
  scorers: [
    containsTools('media_investigate'),
    finalTextIncludes('The Last Detail'),
  ],
  columns: agentColumns(),
});
