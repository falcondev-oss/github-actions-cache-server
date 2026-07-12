import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { getDatabase } from '~/lib/db'
import { Storage } from '~/lib/storage'

const REPO_ID = 'dangling-test'

function lookupArgs(keys: [string, ...string[]]) {
  return { keys, version: 'v1', scopes: ['refs/heads/main'], repoId: REPO_ID }
}

describe('dangling Cache Entry handling at lookup (ADR-0005)', () => {
  const seeded: { locationId: string; folderName: string }[] = []

  async function seedEntry({ key, withStorage }: { key: string; withStorage: boolean }) {
    const db = await getDatabase()
    const adapter = await Storage.getAdapterFromEnv()
    const folderName = randomUUID()
    const locationId = randomUUID()
    const cacheEntryId = randomUUID()

    // A valid, unmerged entry: its first Part exists in storage. A Dangling
    // Cache Entry has the DB rows but no backing storage (external wipe).
    if (withStorage) await adapter.uploadStream(`${folderName}/parts/0`, Readable.from('data'))

    await db
      .insertInto('storage_locations')
      .values({
        id: locationId,
        folderName,
        partCount: 1,
        mergedAt: null,
        mergeStartedAt: null,
        partsDeletedAt: null,
        lastDownloadedAt: null,
      })
      .execute()
    await db
      .insertInto('cache_entries')
      .values({
        id: cacheEntryId,
        key,
        version: 'v1',
        scope: 'refs/heads/main',
        repoId: REPO_ID,
        updatedAt: Date.now(),
        locationId,
      })
      .execute()

    seeded.push({ locationId, folderName })
    return { folderName, locationId, cacheEntryId }
  }

  beforeEach(() => {
    seeded.length = 0
  })
  afterEach(async () => {
    const db = await getDatabase()
    const adapter = await Storage.getAdapterFromEnv()
    await db.deleteFrom('cache_entries').where('repoId', '=', REPO_ID).execute()
    for (const { locationId, folderName } of seeded) {
      await db.deleteFrom('storage_locations').where('id', '=', locationId).execute()
      await adapter.deleteFolder(folderName)
    }
  })

  test('returns a cache miss and self-heals when the backing storage is missing', async () => {
    const storage = await Storage.fromEnv()
    const db = await getDatabase()
    const { cacheEntryId, locationId } = await seedEntry({
      key: 'dangling-key',
      withStorage: false,
    })

    const result = await storage.getCacheEntryWithDownloadUrl(lookupArgs(['dangling-key']))
    expect(result).toBeUndefined()

    const entry = await db
      .selectFrom('cache_entries')
      .where('id', '=', cacheEntryId)
      .selectAll()
      .executeTakeFirst()
    expect(entry).toBeUndefined()

    const location = await db
      .selectFrom('storage_locations')
      .where('id', '=', locationId)
      .selectAll()
      .executeTakeFirst()
    expect(location).toBeUndefined()
  })

  test('falls through to a valid restore key when the best match is dangling', async () => {
    const storage = await Storage.fromEnv()
    await seedEntry({ key: 'build-cache-stale', withStorage: false })
    const { cacheEntryId: validId } = await seedEntry({
      key: 'build-cache-good',
      withStorage: true,
    })

    const result = await storage.getCacheEntryWithDownloadUrl(
      lookupArgs(['build-cache-stale', 'build-cache-good']),
    )

    expect(result?.cacheEntry.id).toBe(validId)
  })
})
