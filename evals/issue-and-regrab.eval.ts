import { evalite } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { containsTools, toolOrder } from './_scorers.js';
import { agentColumns } from './_columns.js';

evalite('issue-and-regrab', {
  data: () => [
    {
      input: {
        prompt:
          'The Matrix in my library has bad audio. Please log it as an issue and grab a different release.',
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
                  mediaInfo: { id: 88, status: 5 },
                },
              ],
            },
          }),
          route('GET', '/api/v1/movie/603', {
            json: { id: 603, mediaInfo: { id: 88, status: 5 } },
          }),
          route('POST', '/api/v1/issue', { json: { id: 12 } }),
          route('GET', '/api/v3/movie?tmdbId=603', {
            json: [
              {
                id: 42,
                title: 'The Matrix',
                year: 1999,
                tmdbId: 603,
                hasFile: true,
                movieFile: {
                  id: 7,
                  relativePath: 'The Matrix (1999)/Matrix.mkv',
                  size: 12_400_000_000,
                  quality: { quality: { name: 'Bluray-1080p' } },
                },
              },
            ],
          }),
          route('DELETE', '/api/v3/moviefile/7', { json: {} }),
          route('POST', '/api/v3/command', {
            json: { id: 99, name: 'MoviesSearch', status: 'queued' },
          }),
        ],
      },
    },
  ],
  task: async (input) => runScenario(input),
  scorers: [
    containsTools('overseerr_report_issue', 'radarr_replace_movie'),
    toolOrder('overseerr_report_issue', 'radarr_replace_movie'),
  ],
  columns: agentColumns(),
});
