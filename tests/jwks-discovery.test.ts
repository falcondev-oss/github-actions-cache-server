import { afterEach, describe, expect, test, vi } from 'vitest'
import { discoverJwksUrl } from '~/lib/scope'

function mockDiscoveryResponse(response: Response) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('discoverJwksUrl', () => {
  test('returns the `jwks_uri` from the discovery document', async () => {
    // an enterprise custom issuer keeps its JWKS at the root host
    mockDiscoveryResponse(
      Response.json({
        issuer: 'https://token.actions.githubusercontent.com/octocat-inc',
        jwks_uri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
      }),
    )

    await expect(discoverJwksUrl()).resolves.toBe(
      'https://token.actions.githubusercontent.com/.well-known/jwks',
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://token.actions.githubusercontent.com/.well-known/openid-configuration',
    )
  })

  test('throws when the discovery document is not served', async () => {
    mockDiscoveryResponse(new Response('Not Found', { status: 404 }))

    await expect(discoverJwksUrl()).rejects.toThrow('404')
  })

  test('throws when the discovery document has no `jwks_uri`', async () => {
    mockDiscoveryResponse(Response.json({ issuer: 'https://token.actions.githubusercontent.com' }))

    await expect(discoverJwksUrl()).rejects.toThrow('`jwks_uri`')
  })
})
