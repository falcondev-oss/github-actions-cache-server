import type { H3Event } from 'h3'
import type { UrlSigningConfig } from '~/lib/url-signing'

import { createHmac } from 'node:crypto'

import arkenv from 'arkenv'
import { describe, expect, test } from 'vitest'
import { envSchema, envSchemaValidated } from '~/lib/schemas'
import {
  redactSignedPath,
  signQuery,
  URL_SIGNING_TTL_MS,
  verifySignedRequest,
} from '~/lib/url-signing'

const SECRET_A = 'secret-aaaaaaaaaaaaaaaaaaaa'
const SECRET_B = 'secret-bbbbbbbbbbbbbbbbbbbb'

function enabled(secret: string, secondary?: string): UrlSigningConfig {
  return { enabled: true, secret, secondary }
}
const disabled: UrlSigningConfig = { enabled: false, secret: '' }

/** Build a minimal H3Event — `getQuery(event)` only reads `event.path`. */
function eventFrom(query: Record<string, string | string[]>): H3Event {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const v of value) usp.append(key, v)
    else usp.append(key, value)
  }
  const qs = usp.toString()
  return { path: `/whatever${qs ? `?${qs}` : ''}` } as unknown as H3Event
}

/** Mirror of the implementation's HMAC, so we can craft expired/tampered URLs. */
function sign(canonicalPath: string, exp: number, secret: string) {
  return createHmac('sha256', secret).update(`${canonicalPath}\n${exp}`).digest('base64url')
}

/** Parse the `?exp=..&sig=..` suffix produced by `signQuery` back into a map. */
function queryFromSuffix(suffix: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(suffix.replace(/^\?/, '')))
}

function expect401(fn: () => void) {
  try {
    fn()
  } catch (err) {
    expect((err as { statusCode?: number }).statusCode).toBe(401)
    return
  }
  throw new Error('expected verifySignedRequest to throw a 401')
}

describe('signQuery', () => {
  test('returns an empty string when disabled', () => {
    expect(signQuery('/upload/1', disabled)).toBe('')
  })

  test('produces exp+sig bound to the canonical path, signed with the active secret', () => {
    const before = Date.now()
    const query = queryFromSuffix(signQuery('/upload/1', enabled(SECRET_A, SECRET_B)))
    const exp = Number(query.exp)

    expect(exp).toBeGreaterThanOrEqual(before + URL_SIGNING_TTL_MS)
    // Signs with the active secret, never the secondary.
    expect(query.sig).toBe(sign('/upload/1', exp, SECRET_A))
    expect(query.sig).not.toBe(sign('/upload/1', exp, SECRET_B))
  })
})

describe('redactSignedPath', () => {
  test('redacts sig while leaving the rest of the path and query intact', () => {
    expect(redactSignedPath('/download/abc?exp=123&sig=deadbeef')).toBe(
      '/download/abc?exp=123&sig=[redacted]',
    )
    // sig as the first param, followed by others.
    expect(redactSignedPath('/upload/1?sig=deadbeef&comp=blocklist')).toBe(
      '/upload/1?sig=[redacted]&comp=blocklist',
    )
  })

  test('is a no-op on paths without a sig param', () => {
    expect(redactSignedPath('/download/abc?exp=123')).toBe('/download/abc?exp=123')
    expect(redactSignedPath('/health')).toBe('/health')
  })
})

describe('verifySignedRequest', () => {
  test('passes for a valid signature', () => {
    const config = enabled(SECRET_A)
    const query = queryFromSuffix(signQuery('/upload/1', config))
    expect(() => verifySignedRequest(eventFrom(query), '/upload/1', config)).not.toThrow()
  })

  test('rejects a tampered signature (401)', () => {
    const config = enabled(SECRET_A)
    const query = queryFromSuffix(signQuery('/upload/1', config))
    expect401(() =>
      verifySignedRequest(eventFrom({ ...query, sig: `${query.sig}x` }), '/upload/1', config),
    )
  })

  test('rejects a tampered path/id (401)', () => {
    const config = enabled(SECRET_A)
    const query = queryFromSuffix(signQuery('/upload/1', config))
    // Same signature, verified against a different canonical path.
    expect401(() => verifySignedRequest(eventFrom(query), '/upload/2', config))
    expect401(() => verifySignedRequest(eventFrom(query), '/download/1', config))
  })

  test('rejects a tampered exp — the signature no longer matches (401)', () => {
    const config = enabled(SECRET_A)
    const query = queryFromSuffix(signQuery('/upload/1', config))
    const bumped = String(Number(query.exp) + 1000)
    expect401(() => verifySignedRequest(eventFrom({ ...query, exp: bumped }), '/upload/1', config))
  })

  test('rejects an expired signature (401)', () => {
    const config = enabled(SECRET_A)
    const exp = Date.now() - 1000
    const sig = sign('/upload/1', exp, SECRET_A)
    expect401(() => verifySignedRequest(eventFrom({ exp: String(exp), sig }), '/upload/1', config))
  })

  test('rejects missing exp or sig (401)', () => {
    const config = enabled(SECRET_A)
    const query = queryFromSuffix(signQuery('/upload/1', config))
    expect401(() => verifySignedRequest(eventFrom({ sig: query.sig }), '/upload/1', config))
    expect401(() => verifySignedRequest(eventFrom({ exp: query.exp }), '/upload/1', config))
    expect401(() => verifySignedRequest(eventFrom({}), '/upload/1', config))
  })

  test('rejects malformed inputs (401): array-valued params, non-integer exp, empty sig', () => {
    const config = enabled(SECRET_A)
    const query = queryFromSuffix(signQuery('/upload/1', config))

    // Duplicated query params → array-valued exp/sig.
    expect401(() =>
      verifySignedRequest(
        eventFrom({ exp: [query.exp, query.exp], sig: query.sig }),
        '/upload/1',
        config,
      ),
    )
    expect401(() =>
      verifySignedRequest(
        eventFrom({ exp: query.exp, sig: [query.sig, query.sig] }),
        '/upload/1',
        config,
      ),
    )
    // Non-integer / non-/^\d+$/ exp.
    expect401(() =>
      verifySignedRequest(eventFrom({ exp: 'abc', sig: query.sig }), '/upload/1', config),
    )
    expect401(() =>
      verifySignedRequest(eventFrom({ exp: '12.5', sig: query.sig }), '/upload/1', config),
    )
    expect401(() =>
      verifySignedRequest(eventFrom({ exp: '-1', sig: query.sig }), '/upload/1', config),
    )
    // Leading zeros are rejected: `Number('0<exp>')` would normalize away the
    // prefix and no longer match the signed string.
    expect401(() =>
      verifySignedRequest(eventFrom({ exp: `0${query.exp}`, sig: query.sig }), '/upload/1', config),
    )
    // Empty sig.
    expect401(() =>
      verifySignedRequest(eventFrom({ exp: query.exp, sig: '' }), '/upload/1', config),
    )
  })

  test('ignores mutable query params (blockid, comp=blocklist)', () => {
    const config = enabled(SECRET_A)
    const query = queryFromSuffix(signQuery('/upload/1', config))

    expect(() =>
      verifySignedRequest(eventFrom({ ...query, blockid: 'AAAA' }), '/upload/1', config),
    ).not.toThrow()
    expect(() =>
      verifySignedRequest(eventFrom({ ...query, comp: 'blocklist' }), '/upload/1', config),
    ).not.toThrow()
  })

  describe('secret rotation (secondary)', () => {
    // Rotation state: SECRET_B is the new active, SECRET_A demoted to secondary.
    test('accepts a URL signed with the active secret', () => {
      const query = queryFromSuffix(signQuery('/upload/1', enabled(SECRET_B)))
      expect(() =>
        verifySignedRequest(eventFrom(query), '/upload/1', enabled(SECRET_B, SECRET_A)),
      ).not.toThrow()
    })

    test('accepts a URL signed with the previous (secondary) secret', () => {
      const query = queryFromSuffix(signQuery('/upload/1', enabled(SECRET_A)))
      expect(() =>
        verifySignedRequest(eventFrom(query), '/upload/1', enabled(SECRET_B, SECRET_A)),
      ).not.toThrow()
    })

    test('rejects a signature from a since-removed secret (401)', () => {
      const query = queryFromSuffix(signQuery('/upload/1', enabled(SECRET_B)))
      // SECRET_B has been fully rotated out; only SECRET_A remains, no secondary.
      expect401(() => verifySignedRequest(eventFrom(query), '/upload/1', enabled(SECRET_A)))
    })
  })

  describe('when disabled', () => {
    test('is a no-op even for unsigned or garbage requests', () => {
      expect(() => verifySignedRequest(eventFrom({}), '/upload/1', disabled)).not.toThrow()
      expect(() =>
        verifySignedRequest(eventFrom({ exp: 'nope', sig: '' }), '/upload/1', disabled),
      ).not.toThrow()
    })
  })
})

describe('envSchemaValidated cross-field validation', () => {
  // Full intersection ⇒ each map must supply a complete valid storage + db env.
  const BASE_ENV = {
    API_BASE_URL: 'http://localhost:3000',
    STORAGE_DRIVER: 'filesystem',
    STORAGE_FILESYSTEM_PATH: '/tmp/storage',
    DB_DRIVER: 'sqlite',
    DB_SQLITE_PATH: '/tmp/test.sqlite',
  }
  // Mirror `lib/env.ts`: validate via arkenv, then `envSchema.assert` to apply the
  // morphs arkenv drops on a narrowed root. Invalid cases throw at the arkenv step.
  const validate = (override: Record<string, string>) =>
    envSchema.assert(arkenv(envSchemaValidated, { env: { ...BASE_ENV, ...override } }))

  test('throws when enabled but URL_SIGNING_SECRET is missing', () => {
    expect(() => validate({ URL_SIGNING_ENABLED: 'true' })).toThrow()
  })

  test('throws when enabled but URL_SIGNING_SECRET is shorter than 16 chars', () => {
    expect(() => validate({ URL_SIGNING_ENABLED: 'true', URL_SIGNING_SECRET: 'short' })).toThrow()
  })

  test('throws when enabled with only URL_SIGNING_SECRET_SECONDARY set (no primary)', () => {
    // A valid secondary cannot substitute for the missing active signer.
    expect(() =>
      validate({ URL_SIGNING_ENABLED: 'true', URL_SIGNING_SECRET_SECONDARY: SECRET_B }),
    ).toThrow()
  })

  test('throws when the secondary is set but shorter than 16 chars', () => {
    expect(() =>
      validate({
        URL_SIGNING_ENABLED: 'true',
        URL_SIGNING_SECRET: SECRET_A,
        URL_SIGNING_SECRET_SECONDARY: 'short',
      }),
    ).toThrow()
  })

  test('passes when enabled with a valid primary (no secondary)', () => {
    expect(() =>
      validate({ URL_SIGNING_ENABLED: 'true', URL_SIGNING_SECRET: SECRET_A }),
    ).not.toThrow()
  })

  test('passes when enabled with a valid primary and secondary', () => {
    expect(() =>
      validate({
        URL_SIGNING_ENABLED: 'true',
        URL_SIGNING_SECRET: SECRET_A,
        URL_SIGNING_SECRET_SECONDARY: SECRET_B,
      }),
    ).not.toThrow()
  })

  test('passes when explicitly disabled with no secret', () => {
    expect(() => validate({ URL_SIGNING_ENABLED: 'false' })).not.toThrow()
  })

  test('passes when unset with no secret (default-before-narrow ordering guard)', () => {
    // Pins the arkenv ordering assumption: the narrow observes the applied
    // default `false`, not `undefined`. An arkenv upgrade that changes this
    // fails here loudly instead of silently disabling the boot check.
    const result = validate({})
    expect(result.URL_SIGNING_ENABLED).toBe(false)
  })

  test('applies object morphs (arkenv drops them on a narrowed root)', () => {
    // Regression guard: switching `env` to the narrowed schema previously
    // silently disabled every morph. The two-pass in `lib/env.ts` must restore
    // them — here the trailing-slash strip on API_BASE_URL.
    const result = validate({ API_BASE_URL: 'http://localhost:3000///' })
    expect(result.API_BASE_URL).toBe('http://localhost:3000')
  })

  test('trims secrets in the parsed output', () => {
    // A valid secret with surrounding whitespace (e.g. a trailing newline from a
    // mounted secret file) is accepted and stored trimmed.
    const result = validate({ URL_SIGNING_ENABLED: 'true', URL_SIGNING_SECRET: `  ${SECRET_A}\n` })
    expect(result.URL_SIGNING_SECRET).toBe(SECRET_A)
  })

  test('rejects a whitespace-padded secret whose trimmed length is < 16', () => {
    // The narrow must trim before the length check (it sees the raw value), or a
    // padded-short secret would slip through.
    expect(() =>
      validate({ URL_SIGNING_ENABLED: 'true', URL_SIGNING_SECRET: `${' '.repeat(20)}ab` }),
    ).toThrow()
  })
})
