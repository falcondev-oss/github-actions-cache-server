import type { H3Event } from 'h3'

import { createHmac, timingSafeEqual } from 'node:crypto'

import { createError, getQuery } from 'h3'
import { env } from '~/lib/env'

/**
 * Fixed lifetime of a signed URL. Not configurable: 1h keeps a leaked URL
 * short-lived while covering any realistic upload. The upload signature is minted
 * once at `CreateCacheEntry` for the whole multi-chunk upload. Clients do not
 * re-fetch the upload URL on 401 so an upload exceeding 1h fails hard.
 */
export const URL_SIGNING_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Redact the `sig` bearer credential from a path/URL before it is logged. `sig`
 * is replayable for the whole TTL, so a leaked log line must not carry it; the
 * rest of the path and query (including `exp`) is left intact. Every code path
 * that logs a request path MUST route through this.
 */
export function redactSignedPath(path: string): string {
  return path.replace(/([?&]sig=)[^&]*/i, '$1[redacted]')
}

export interface UrlSigningConfig {
  enabled: boolean
  /** The active signing secret. Also the first candidate on verify. */
  secret: string
  /** Optional verify-only rotation secret (the previous `secret`). */
  secondary?: string
}

/**
 * The only reader of the `env` singleton. The core takes config explicitly so it
 * can be unit-tested across enabled/disabled/rotation cases without env juggling.
 */
export function urlSigningConfigFromEnv(): UrlSigningConfig {
  return {
    enabled: env.URL_SIGNING_ENABLED,
    secret: env.URL_SIGNING_SECRET ?? '',
    secondary: env.URL_SIGNING_SECRET_SECONDARY || undefined,
  }
}

/** Ordered verify candidates: the active secret first, then the rotation secret. */
function verifySecrets(config: UrlSigningConfig): string[] {
  return [config.secret, config.secondary].filter((s): s is string => Boolean(s))
}

function computeSignature(canonicalPath: string, exp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${canonicalPath}\n${exp}`).digest('base64url')
}

/**
 * Build the `?exp=<unixMs>&sig=<base64url>` suffix binding `canonicalPath + exp`.
 * Returns `''` when disabled. Always signs with the active `config.secret`.
 *
 * `canonicalPath` MUST be an invariant resource id (e.g. `/upload/{id}`) built
 * from the raw route param — never `event.path` — so the route alias and any
 * reverse-proxy/base-path prefix all verify against the same signed material.
 */
export function signQuery(canonicalPath: string, config: UrlSigningConfig): string {
  if (!config.enabled) return ''

  const exp = Date.now() + URL_SIGNING_TTL_MS
  const sig = computeSignature(canonicalPath, exp, config.secret)
  return `?exp=${exp}&sig=${sig}`
}

/**
 * Strictly verify the `exp`/`sig` query params against `canonicalPath`. No-op
 * when disabled. Throws 401 for every failure (missing/malformed params, mismatch,
 * expiry). Tries the active secret then the secondary.
 *
 * Excludes mutable query params (Azure `blockid`, `comp=blocklist`), so one
 * `CreateCacheEntry`-issued signature validates every chunk PUT and the final
 * blocklist PUT within the TTL.
 */
export function verifySignedRequest(
  event: H3Event,
  canonicalPath: string,
  config: UrlSigningConfig,
): void {
  if (!config.enabled) return

  const query = getQuery(event)
  const exp = query.exp
  const sig = query.sig

  // Validate before any HMAC/expiry work.
  if (
    typeof exp !== 'string' || // reject array-valued exp (repeated query param)
    typeof sig !== 'string' || // reject array-valued sig (repeated query param)
    !/^[1-9]\d*$/.test(exp) || // digits only, no leading zeros so exp round-trips through Number()
    sig.length === 0           // reject empty sig
  )
    throw createError({ statusCode: 401 })

  const expMs = Number(exp)
  if (!Number.isSafeInteger(expMs) || expMs <= 0) throw createError({ statusCode: 401 })

  const provided = Buffer.from(sig, 'base64url')
  const matched = verifySecrets(config).some((secret) => {
    const expected = Buffer.from(computeSignature(canonicalPath, expMs, secret), 'base64url')
    return expected.length === provided.length && timingSafeEqual(expected, provided)
  })
  if (!matched) throw createError({ statusCode: 401 })

  if (Date.now() > expMs) throw createError({ statusCode: 401 })
}
