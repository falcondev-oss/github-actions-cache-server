import type { H3Event } from 'h3'
import * as jose from 'jose'
import { hasAtLeast } from 'remeda'
import { env } from './env'
import { logger } from './logger'

const JWKS = jose.createRemoteJWKSet(
  new URL('https://token.actions.githubusercontent.com/.well-known/jwks'),
)

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
      issuer: 'https://token.actions.githubusercontent.com',
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

export async function getCacheScopes(event: H3Event) {
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

  return scopes
}
