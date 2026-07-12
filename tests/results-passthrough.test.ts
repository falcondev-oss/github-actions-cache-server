import type { CapturedResultsRequest } from './results-origin'
import { expect, test } from 'vitest'

test('global fallback forwards an unhandled nested Twirp request unchanged', async () => {
  const requestBody = '{"name":"build-output","version":4}'
  const response = await fetch(
    'http://localhost:3000/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact?api-version=6.0-preview.1',
    {
      method: 'POST',
      headers: {
        'authorization': 'Bearer artifact-token',
        'content-type': 'application/json',
        'x-artifact-request': 'create',
      },
      body: requestBody,
    },
  )

  expect(response.status).toBe(409)
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(response.headers.get('x-results-origin')).toBe('fake')
  await expect(response.text()).resolves.toBe(
    '{"code":"already_exists","msg":"artifact already exists"}',
  )

  const requestsResponse = await fetch(`${process.env.DEFAULT_ACTIONS_RESULTS_URL}/_test/requests`)
  const requests = (await requestsResponse.json()) as CapturedResultsRequest[]

  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    body: requestBody,
    headers: {
      'authorization': 'Bearer artifact-token',
      'content-type': 'application/json',
      'x-artifact-request': 'create',
    },
    method: 'POST',
    url: '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact?api-version=6.0-preview.1',
  })
})
