import type { H3Event } from 'h3'
import * as jose from 'jose'
import { hasAtLeast } from 'remeda'
import { env } from './env'
import { logger } from './logger'

const issuer = env.ACTIONS_TOKEN_ISSUER.replace(/\/$/, '')

const fallbackJwksUrl = `${issuer}/.well-known/jwks`

/**
 * The JWKS URL can't be derived from the issuer: an enterprise with a custom
 * issuer value (`{host}/{enterpriseSlug}`) still serves its JWKS at `{host}`.
 * Ask the OIDC discovery document instead.
 */
export async function discoverJwksUrl() {
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`

  const res = await fetch(discoveryUrl)
  if (!res.ok) throw new Error(`Unexpected status ${res.status} ${res.statusText}`)

  const config = (await res.json()) as { jwks_uri?: unknown }
  if (typeof config.jwks_uri !== 'string')
    throw new Error(`Discovery document at ${discoveryUrl} has no \`jwks_uri\``)

  return config.jwks_uri
}

const createJwks = (url: string) => jose.createRemoteJWKSet(new URL(url))

const overrideJwks = env.ACTIONS_TOKEN_JWKS_URL ? createJwks(env.ACTIONS_TOKEN_JWKS_URL) : undefined
const fallbackJwks = createJwks(fallbackJwksUrl)
// holder object instead of a bare `let`, which can't be assigned to from inside
// a function (`unicorn/no-top-level-assignment-in-function`)
const cache: { jwks?: jose.JWTVerifyGetKey } = {}

async function getJwks() {
  if (overrideJwks) return overrideJwks
  if (cache.jwks) return cache.jwks

  try {
    return (cache.jwks = createJwks(await discoverJwksUrl()))
  } catch (err) {
    logger.warn(
      `OIDC discovery failed, falling back to ${fallbackJwksUrl}. Set ACTIONS_TOKEN_JWKS_URL if token validation keeps failing.`,
      err,
    )
    // Deliberately not cached, so the next request retries discovery instead of
    // pinning the process to a URL that may well be the wrong one.
    return fallbackJwks
  }
}

function getBearerToken(event: H3Event) {
  const authHeader = getHeader(event, 'authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return

  return authHeader.slice(7)
}

async function verifyGitHubActionsToken(token: string) {
  if (env.SKIP_TOKEN_VALIDATION) {
    logger.warn('Token validation is disabled. This should not be used in production!')
    return jose.decodeJwt(token)
  }

  const { payload } = await jose.jwtVerify(token, await getJwks(), { issuer })
  return payload
}

function parseJsonScopes(json: string) {
  try {
    return JSON.parse(json)
  } catch (err) {
    throw createError({
      statusCode: 401,
      message: 'Invalid JSON in cache scopes',
      cause: err,
    })
  }
}

export async function getCacheScope(event: H3Event) {
  const token = getBearerToken(event)
  if (!token)
    throw createError({ statusCode: 401, message: 'Authorization header missing or malformed' })

  const decoded = await verifyGitHubActionsToken(token).catch((err) => {
    throw createError({
      statusCode: 401,
      message: 'Invalid token',
      cause: err,
    })
  })

  const scopesJson = decoded.ac
  if (!scopesJson || typeof scopesJson !== 'string')
    throw createError({ statusCode: 401, message: 'Token does not contain cache scopes' })

  const scopes = parseJsonScopes(scopesJson) as Array<{ Scope: string; Permission: number }>
  if (!hasAtLeast(scopes, 1))
    throw createError({ statusCode: 401, message: 'Token does not contain any cache scopes' })

  const repoId = decoded.repository_id
  if (!repoId || typeof repoId !== 'string')
    throw createError({ statusCode: 401, message: 'Token does not contain repository id' })

  return {
    scopes,
    repoId,
  }
}
