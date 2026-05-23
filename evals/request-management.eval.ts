import { evalite } from 'evalite';
import { createScorer } from 'evalite';
import { runScenario } from './_runner.js';
import { route } from '../src/tools/_testing.js';
import { agentColumns } from './_columns.js';

function requestListRoutes() {
  return [
    route('GET', '/api/v1/request', {
      json: {
        results: [
          {
            id: 4163,
            status: 2,
            createdAt: '2026-05-23T02:11:00Z',
            updatedAt: '2026-05-23T02:11:00Z',
            type: 'movie',
            is4k: false,
            media: { tmdbId: 11159, status: 3, mediaType: 'movie' },
          },
        ],
      },
    }),
    route('GET', '/api/v1/movie/11159', {
      json: { title: 'The Last Detail', releaseDate: '1973-12-12' },
    }),
  ];
}

evalite('request-management', {
  data: () => [
    {
      input: {
        prompt: 'List current requests in Overseerr.',
        routes: requestListRoutes(),
        expectedTool: 'overseerr_list_requests',
        expectedText: 'The Last Detail',
      },
    },
    {
      input: {
        prompt: 'Show pending Overseerr requests.',
        routes: [route('GET', '/api/v1/request', { json: { results: [] } })],
        expectedTool: 'overseerr_list_requests',
        expectedStatus: 'pending',
      },
    },
    {
      input: {
        prompt: 'Approve Overseerr request 4163.',
        routes: [
          route('GET', '/api/v1/auth/me', { json: {} }),
          route('POST', '/api/v1/request/4163/approve', { json: { id: 4163, status: 2 } }),
        ],
        expectedTool: 'overseerr_approve_request',
        expectedId: 4163,
      },
    },
    {
      input: {
        prompt: 'Reject Overseerr request 4163.',
        routes: [
          route('GET', '/api/v1/auth/me', { json: {} }),
          route('POST', '/api/v1/request/4163/decline', { json: { id: 4163, status: 3 } }),
        ],
        expectedTool: 'overseerr_reject_request',
        expectedId: 4163,
      },
    },
    {
      input: {
        prompt: 'Delete Overseerr request 4163.',
        routes: [
          route('GET', '/api/v1/auth/me', { json: {} }),
          route('DELETE', '/api/v1/request/4163', { json: { id: 4163, deleted: true } }),
        ],
        expectedTool: 'overseerr_delete_request',
        expectedId: 4163,
      },
    },
  ],
  task: async (input) => runScenario(input as Parameters<typeof runScenario>[0]),
  scorers: [
    createScorer({
      name: 'expected tool called once',
      scorer: ({ input, output }) => {
        const expected = (input as { expectedTool: string }).expectedTool;
        const actual = output.toolCalls.filter((c) => c.name === expected).length;
        return { score: actual === 1 ? 1 : 0, metadata: { expected, actual } };
      },
    }),
    createScorer({
      name: 'expected request id',
      scorer: ({ input, output }) => {
        const expectedId = (input as { expectedId?: number }).expectedId;
        if (!expectedId) return { score: 1, metadata: { skipped: true } };
        const expectedTool = (input as { expectedTool: string }).expectedTool;
        const call = output.toolCalls.find((c) => c.name === expectedTool);
        return {
          score: ((call?.input as { id?: number } | undefined)?.id === expectedId) ? 1 : 0,
          metadata: { actual: call?.input ?? null, expectedId },
        };
      },
    }),
    createScorer({
      name: 'expected request status filter',
      scorer: ({ input, output }) => {
        const expectedStatus = (input as { expectedStatus?: string }).expectedStatus;
        if (!expectedStatus) return { score: 1, metadata: { skipped: true } };
        const call = output.toolCalls.find((c) => c.name === 'overseerr_list_requests');
        return {
          score: ((call?.input as { status?: string } | undefined)?.status === expectedStatus) ? 1 : 0,
          metadata: { actual: call?.input ?? null, expectedStatus },
        };
      },
    }),
    createScorer({
      name: 'expected final text',
      scorer: ({ input, output }) => {
        const expectedText = (input as { expectedText?: string }).expectedText;
        if (!expectedText) return { score: 1, metadata: { skipped: true } };
        return {
          score: output.finalText.toLowerCase().includes(expectedText.toLowerCase()) ? 1 : 0,
          metadata: { expectedText, finalText: output.finalText },
        };
      },
    }),
  ],
  columns: agentColumns(),
});
