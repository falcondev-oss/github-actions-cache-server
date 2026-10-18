/* eslint-disable unicorn/no-top-level-assignment-in-function */
import crypto from 'node:crypto'

import { SignJWT } from 'jose'
import { beforeAll, expect, test } from 'vitest'

const endpoint =
  'http://localhost:3000/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry'

let token: string

beforeAll(async () => {
  token = await new SignJWT({
    ac: JSON.stringify([{ Scope: 'refs/heads/main', Permission: 3 }]),
    repository_id: '123',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(crypto.createSecretKey('mock-secret-key', 'ascii'))
})

function reserve(key: string) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key, version: 'v1' }),
  })
}

test('duplicate CreateCacheEntry returns 409 already_exists', async () => {
  await reserve('duplicate-key')

  const duplicate = await reserve('duplicate-key')
  expect(duplicate.status).toBe(409)
  await expect(duplicate.json()).resolves.toEqual({
    code: 'already_exists',
    msg: 'cache entry with the same key, version, and scope already exists',
  })
})
