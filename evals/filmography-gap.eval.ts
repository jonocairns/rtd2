import { evalite } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { containsTools, finalTextIncludes } from './_scorers.js';
import { agentColumns } from './_columns.js';

evalite('filmography-gap', {
  data: () => [
    {
      input: {
        prompt: 'What Kubrick films am I missing from my library?',
        routes: [
          route('GET', '/api/v1/search', {
            json: {
              results: [
                {
                  id: 240,
                  mediaType: 'person',
                  name: 'Stanley Kubrick',
                  knownForDepartment: 'Directing',
                  knownFor: [],
                },
              ],
            },
          }),
          route('GET', '/api/v1/person/240/combined_credits', {
            json: {
              cast: [],
              crew: [
                {
                  id: 694,
                  media_type: 'movie',
                  title: 'The Shining',
                  release_date: '1980-05-23',
                  department: 'Directing',
                  job: 'Director',
                  mediaInfo: { status: 5 },
                },
                {
                  id: 4133,
                  media_type: 'movie',
                  title: 'Barry Lyndon',
                  release_date: '1975-12-18',
                  department: 'Directing',
                  job: 'Director',
                  mediaInfo: null,
                },
                {
                  id: 311,
                  media_type: 'movie',
                  title: 'Eyes Wide Shut',
                  release_date: '1999-07-16',
                  department: 'Directing',
                  job: 'Director',
                  mediaInfo: { status: 5 },
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
    containsTools('overseerr_search_person', 'overseerr_person_credits'),
    finalTextIncludes('Barry Lyndon'),
  ],
  columns: agentColumns(),
});
