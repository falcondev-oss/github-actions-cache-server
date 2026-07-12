import type { H3Event } from 'h3'
import * as jose from 'jose'
import { hasAtLeast } from 'remeda'
import { env } from './env'
import { logger } from './logger'

// ponytail: JWKS URL derived from the issuer as GitHub (and GHES, sharing the
// same Actions stack) serves it at `{issuer}/.well-known/jwks`. Add an explicit
// JWKS override var if a real GHES layout ever splits the JWKS host from the issuer.
const issuer = env.ACTIONS_TOKEN_ISSUER.replace(/\/$/, '')
const JWKS = jose.createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`))

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

  return jose
    .jwtVerify(token, JWKS, {
      issuer: env.ACTIONS_TOKEN_ISSUER,
    })
    .then((res) => res.payload)
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
