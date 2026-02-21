import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { restoreCache, saveCache } from '@actions/cache'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { TEST_TEMP_DIR } from './setup'

const testFilePath = path.join(TEST_TEMP_DIR, 'test.bin')

const MB = 1024 * 1024
const BASE_URL = process.env.API_BASE_URL!

describe('GET /internal/caches', () => {
  beforeAll(async () => {
    process.env.ACTIONS_CACHE_SERVICE_V2 = 'true'
    process.env.ACTIONS_RUNTIME_TOKEN = 'mock-runtime-token'

    // seed two distinct cache entries
    const buf = crypto.randomBytes(1024)
    await fs.writeFile(testFilePath, buf)
    await saveCache([testFilePath], 'list-test-key-alpha')
    await saveCache([testFilePath], 'list-test-key-beta')
  })
  afterAll(() => {
    delete process.env.ACTIONS_CACHE_SERVICE_V2
    delete process.env.ACTIONS_RUNTIME_TOKEN
  })

  test('returns all entries with default pagination', async () => {
    const res = await fetch(`${BASE_URL}/internal/caches`)
    expect(res.status).toBe(200)
    const body = await res.json() as { items: unknown[]; total: number; page: number; limit: number }
    expect(body.page).toBe(0)
    expect(body.limit).toBe(20)
    expect(typeof body.total).toBe('number')
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.total).toBeGreaterThanOrEqual(2)
  })

  test('filters by key prefix', async () => {
    const res = await fetch(`${BASE_URL}/internal/caches?key=list-test-key-alpha`)
    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ key: string }>; total: number }
    expect(body.total).toBeGreaterThanOrEqual(1)
    for (const item of body.items) {
      expect(item.key).toMatch(/^list-test-key-alpha/)
    }
  })

  test('filters by version returns only matching version', async () => {
    // fetch the version of a known entry from the listing, then filter by it
    const all = await fetch(`${BASE_URL}/internal/caches?key=list-test-key-alpha`)
    const allBody = await all.json() as { items: Array<{ key: string; version: string }> }
    const knownVersion = allBody.items[0]!.version

    const res = await fetch(`${BASE_URL}/internal/caches?version=${knownVersion}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ version: string }> }
    for (const item of body.items) {
      expect(item.version).toBe(knownVersion)
    }
  })

  test('pagination with limit=1', async () => {
    const resP0 = await fetch(`${BASE_URL}/internal/caches?limit=1&page=0`)
    const resP1 = await fetch(`${BASE_URL}/internal/caches?limit=1&page=1`)
    expect(resP0.status).toBe(200)
    expect(resP1.status).toBe(200)
    const bodyP0 = await resP0.json() as { items: Array<{ id: string }> }
    const bodyP1 = await resP1.json() as { items: Array<{ id: string }> }
    expect(bodyP0.items).toHaveLength(1)
    expect(bodyP1.items).toHaveLength(1)
    expect(bodyP0.items[0]!.id).not.toBe(bodyP1.items[0]!.id)
  })

  test('returns 400 for invalid query params', async () => {
    const res = await fetch(`${BASE_URL}/internal/caches?limit=999`)
    expect(res.status).toBe(400)
  })
})

describe(`save and restore cache with @actions/cache package`, () => {
  beforeAll(() => {
    process.env.ACTIONS_CACHE_SERVICE_V2 = 'true'
    process.env.ACTIONS_RUNTIME_TOKEN = 'mock-runtime-token'
  })
  afterAll(() => {
    delete process.env.ACTIONS_CACHE_SERVICE_V2
    delete process.env.ACTIONS_RUNTIME_TOKEN
  })

  for (const size of [1, 2 * MB, 64 * MB, 128 * MB, 512 * MB])
    test(`${size} Bytes`, { timeout: 90_000 }, async () => {
      // save
      const expectedContents = crypto.randomBytes(size)
      await fs.writeFile(testFilePath, expectedContents)
      await saveCache([testFilePath], 'cache-key')
      await fs.rm(testFilePath)

      // restore
      const cacheHitKey = await restoreCache([testFilePath], 'cache-key')
      expect(cacheHitKey).toBe('cache-key')

      // check contents
      const restoredContents = await fs.readFile(testFilePath)
      expect(restoredContents.compare(expectedContents)).toBe(0)
    })
})
