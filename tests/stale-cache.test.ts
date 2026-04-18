import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { restoreCache, saveCache } from '@actions/cache'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Storage } from '~/lib/storage'
import { TEST_TEMP_DIR } from './setup'

const testFilePath = path.join(TEST_TEMP_DIR, 'test-stale.bin')

describe('stale cache entry handling (missing storage objects)', () => {
  let adapter: Awaited<ReturnType<typeof Storage.getAdapterFromEnv>>

  beforeAll(async () => {
    process.env.ACTIONS_CACHE_SERVICE_V2 = 'true'
    process.env.ACTIONS_RUNTIME_TOKEN = await new SignJWT({
      ac: JSON.stringify([{ Scope: 'refs/heads/main', Permission: 3 }]),
      repository_id: '123',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(crypto.createSecretKey('mock-secret-key', 'ascii'))

    adapter = await Storage.getAdapterFromEnv()
  })
  afterAll(() => {
    delete process.env.ACTIONS_CACHE_SERVICE_V2
    delete process.env.ACTIONS_RUNTIME_TOKEN
  })

  test(
    'returns cache miss when parts are wiped before first download (unmerged entry)',
    { timeout: 30_000 },
    async () => {
      const contents = crypto.randomBytes(1024)
      await fs.writeFile(testFilePath, contents)
      await saveCache([testFilePath], 'stale-fresh-key')
      await fs.rm(testFilePath)

      await adapter.clear()

      const missKey = await restoreCache([testFilePath], 'stale-fresh-key')
      expect(missKey).toBeUndefined()

      const missKey2 = await restoreCache([testFilePath], 'stale-fresh-key')
      expect(missKey2).toBeUndefined()
    },
  )

  test(
    'returns cache miss when the merged blob is wiped after merge completes',
    { timeout: 30_000 },
    async () => {
      const contents = crypto.randomBytes(1024)
      await fs.writeFile(testFilePath, contents)
      await saveCache([testFilePath], 'stale-merged-key')
      await fs.rm(testFilePath)

      const hitKey = await restoreCache([testFilePath], 'stale-merged-key')
      expect(hitKey).toBe('stale-merged-key')
      await fs.rm(testFilePath)

      // Wait for the background merge to flush before wiping storage.
      await new Promise((resolve) => setTimeout(resolve, 2000))

      await adapter.clear()

      const missKey = await restoreCache([testFilePath], 'stale-merged-key')
      expect(missKey).toBeUndefined()

      const missKey2 = await restoreCache([testFilePath], 'stale-merged-key')
      expect(missKey2).toBeUndefined()
    },
  )

  test(
    'falls back to a valid restore key when the best match has missing storage',
    { timeout: 30_000 },
    async () => {
      // Seed an entry we will later wipe from storage (keeping the DB row).
      const staleContents = crypto.randomBytes(1024)
      await fs.writeFile(testFilePath, staleContents)
      await saveCache([testFilePath], 'restore-fallback-stale')
      await fs.rm(testFilePath)

      // Let any background merge settle before wiping storage.
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await adapter.clear()

      // Seed a second entry whose storage is intact. Because this row is the
      // most recently updated, matchCacheEntry prefers 'restore-fallback-stale'
      // (our first restore key) only if we put it first; to force the stale
      // row to win we list it ahead of the valid one in restoreKeys.
      const validContents = crypto.randomBytes(1024)
      await fs.writeFile(testFilePath, validContents)
      await saveCache([testFilePath], 'restore-fallback-valid')
      await fs.rm(testFilePath)

      // Primary miss, restore keys: stale first (DB row but no storage), then valid.
      // The fix must purge the stale row and fall through to the valid one.
      const hitKey = await restoreCache([testFilePath], 'restore-fallback-missing-primary', [
        'restore-fallback-stale',
        'restore-fallback-valid',
      ])
      expect(hitKey).toBe('restore-fallback-valid')
    },
  )
})
