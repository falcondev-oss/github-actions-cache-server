import { describe, expect, test } from 'vitest'

describe('twirp catch-all route', () => {
  test(
    'unmatched twirp paths should not return 404',
    { timeout: 10_000 },
    async () => {
      const res = await fetch(
        `${process.env.API_BASE_URL}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      )
      expect(res.status).toBe(200)
    },
  )
})
