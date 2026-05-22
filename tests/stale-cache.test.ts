import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { restoreCache, saveCache } from '@actions/cache'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getDatabase } from '~/lib/db'
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
    'keeps parts after merge so parallel part restores can finish',
    { timeout: 30_000 },
    async () => {
      const key = 'stale-merge-grace-key'
      const contents = crypto.randomBytes(1024)
      await fs.writeFile(testFilePath, contents)
      await saveCache([testFilePath], key)
      await fs.rm(testFilePath)

      const hitKey = await restoreCache([testFilePath], key)
      expect(hitKey).toBe(key)
      await fs.rm(testFilePath)

      // Wait for the background merge to flush before checking retained parts.
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const db = await getDatabase()
      const location = await db
        .selectFrom('cache_entries')
        .innerJoin('storage_locations', 'storage_locations.id', 'cache_entries.locationId')
        .where('cache_entries.key', '=', key)
        .select([
          'storage_locations.folderName',
          'storage_locations.partCount',
          'storage_locations.mergedAt',
          'storage_locations.partsDeletedAt',
        ])
        .executeTakeFirstOrThrow()

      expect(location.mergedAt).not.toBeNull()
      expect(location.partsDeletedAt).toBeNull()
      await expect(adapter.countFilesInFolder(`${location.folderName}/parts`)).resolves.toBe(
        location.partCount,
      )
    },
  )

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

      const db = await getDatabase()
      await expect(
        db
          .selectFrom('cache_entries')
          .where('key', '=', 'stale-fresh-key')
          .select('id')
          .executeTakeFirst(),
      ).resolves.toBeUndefined()
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

      const db = await getDatabase()
      await expect(
        db
          .selectFrom('cache_entries')
          .where('key', '=', 'stale-merged-key')
          .select('id')
          .executeTakeFirst(),
      ).resolves.toBeUndefined()
    },
  )
})
