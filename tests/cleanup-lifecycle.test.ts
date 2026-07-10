import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { Storage } from '~/lib/storage'

describe('cleanup lifecycle', () => {
  beforeAll(() => {
    vi.stubGlobal('defineTask', (definition: unknown) => definition)
  })
  afterAll(() => vi.unstubAllGlobals())

  test('retention drains more than one page of never-downloaded entries', async () => {
    const db = await getDatabase()
    const adapter = await Storage.getAdapterFromEnv()
    const locations = Array.from({ length: 11 }, () => ({
      id: randomUUID(),
      folderName: `retention-${randomUUID()}`,
    }))
    for (const location of locations) {
      await adapter.uploadStream(`${location.folderName}/parts/0`, Readable.from('expired'))
      await db
        .insertInto('storage_locations')
        .values({
          ...location,
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
          id: randomUUID(),
          key: randomUUID(),
          version: 'v1',
          scope: 'refs/heads/main',
          repoId: '123',
          updatedAt: Date.now() - 91 * 24 * 60 * 60 * 1000,
          locationId: location.id,
        })
        .execute()
    }

    const taskModule = await import('~/tasks/cleanup/cache-entries')
    const task = taskModule.default
    await task.run({} as never)

    for (const location of locations) {
      expect(
        await db
          .selectFrom('storage_locations')
          .where('id', '=', location.id)
          .select('id')
          .executeTakeFirst(),
      ).toBeUndefined()
      expect(await adapter.countFilesInFolder(`${location.folderName}/parts`)).toBe(0)
    }
  })

  test('part cleanup waits until an active parts download releases its reader lease', async () => {
    const db = await getDatabase()
    const storage = await Storage.fromEnv()
    const folderName = `reader-${randomUUID()}`
    const locationId = randomUUID()
    const entryId = randomUUID()
    await storage.adapter.uploadStream(`${folderName}/parts/0`, Readable.from('cache-data'))
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
        id: entryId,
        key: randomUUID(),
        version: 'v1',
        scope: 'refs/heads/main',
        repoId: '123',
        updatedAt: Date.now(),
        locationId,
      })
      .execute()

    try {
      const mergingDownload = await storage.download(entryId)
      const activePartsDownload = await storage.download(entryId)
      expect(mergingDownload).toBeDefined()
      expect(activePartsDownload).toBeDefined()
      for await (const _chunk of mergingDownload!) void _chunk
      await storage.waitForOngoingMerges()

      const taskModule = await import('~/tasks/cleanup/parts')
      const task = taskModule.default
      await task.run({} as never)
      expect(await storage.adapter.countFilesInFolder(`${folderName}/parts`)).toBe(1)

      for await (const _chunk of activePartsDownload!) void _chunk
      await new Promise((resolve) => setTimeout(resolve, 50))
      await task.run({} as never)
      expect(await storage.adapter.countFilesInFolder(`${folderName}/parts`)).toBe(0)

      const mergedDownload = await storage.download(entryId)
      expect(mergedDownload).toBeDefined()
      let restored = ''
      for await (const chunk of mergedDownload!) restored += chunk.toString()
      expect(restored).toBe('cache-data')
    } finally {
      await db.deleteFrom('storage_locations').where('id', '=', locationId).execute()
      await storage.adapter.deleteFolder(folderName)
    }
  })

  test('storage-location cleanup waits for an active merged download', async () => {
    const db = await getDatabase()
    const storage = await Storage.fromEnv()
    const folderName = `storage-reader-${randomUUID()}`
    const locationId = randomUUID()
    const entryId = randomUUID()
    await storage.adapter.uploadStream(`${folderName}/merged`, Readable.from('merged-data'))
    await db
      .insertInto('storage_locations')
      .values({
        id: locationId,
        folderName,
        partCount: 0,
        mergedAt: Date.now(),
        mergeStartedAt: Date.now(),
        partsDeletedAt: Date.now(),
        lastDownloadedAt: null,
      })
      .execute()
    await db
      .insertInto('cache_entries')
      .values({
        id: entryId,
        key: randomUUID(),
        version: 'v1',
        scope: 'refs/heads/main',
        repoId: '123',
        updatedAt: Date.now(),
        locationId,
      })
      .execute()

    const download = await storage.download(entryId)
    expect(download).toBeDefined()
    await db.deleteFrom('cache_entries').where('id', '=', entryId).execute()
    const taskModule = await import('~/tasks/cleanup/storage-locations')
    const task = taskModule.default
    await task.run({} as never)
    expect(await storage.adapter.countFilesInFolder(folderName)).toBe(1)

    for await (const _chunk of download!) void _chunk
    await new Promise((resolve) => setTimeout(resolve, 50))
    await task.run({} as never)
    expect(await storage.adapter.countFilesInFolder(folderName)).toBe(0)
  })

  test.skipIf(process.env.VITEST_STORAGE_DRIVER !== 's3')(
    'a direct-download reader lease covers the signed URL lifetime',
    async () => {
      const db = await getDatabase()
      const storage = await Storage.fromEnv()
      const folderName = `direct-reader-${randomUUID()}`
      const locationId = randomUUID()
      const entryId = randomUUID()
      const key = randomUUID()
      const directDownloadsEnabled = env.ENABLE_DIRECT_DOWNLOADS
      await storage.adapter.uploadStream(`${folderName}/merged`, Readable.from('merged-data'))
      await db
        .insertInto('storage_locations')
        .values({
          id: locationId,
          folderName,
          partCount: 0,
          mergedAt: Date.now(),
          mergeStartedAt: Date.now(),
          partsDeletedAt: Date.now(),
          lastDownloadedAt: null,
        })
        .execute()
      await db
        .insertInto('cache_entries')
        .values({
          id: entryId,
          key,
          version: 'v1',
          scope: 'refs/heads/main',
          repoId: '123',
          updatedAt: Date.now(),
          locationId,
        })
        .execute()

      try {
        env.ENABLE_DIRECT_DOWNLOADS = true
        const startedAt = Date.now()
        const result = await storage.getCacheEntryWithDownloadUrl({
          keys: [key],
          version: 'v1',
          scopes: ['refs/heads/main'],
          repoId: '123',
        })
        const lease = await db
          .selectFrom('storage_reader_leases')
          .where('storageLocationId', '=', locationId)
          .select('expiresAt')
          .executeTakeFirstOrThrow()
        const url = new URL(result!.downloadUrl)
        const signedLifetimeSeconds = Number(
          url.searchParams.get('X-Amz-Expires') ?? url.searchParams.get('X-Goog-Expires'),
        )

        expect(signedLifetimeSeconds).toBeGreaterThan(0)
        expect(lease.expiresAt - startedAt).toBeGreaterThanOrEqual(signedLifetimeSeconds * 1000)
      } finally {
        env.ENABLE_DIRECT_DOWNLOADS = directDownloadsEnabled
        await db.deleteFrom('storage_locations').where('id', '=', locationId).execute()
        await storage.adapter.deleteFolder(folderName)
      }
    },
  )

  test('an active download fails when its reader lease is lost', async () => {
    const db = await getDatabase()
    const storage = await Storage.fromEnv()
    const folderName = `lost-reader-${randomUUID()}`
    const locationId = randomUUID()
    const entryId = randomUUID()
    await storage.adapter.uploadStream(`${folderName}/parts/0`, Readable.from('cache-data'))
    await db
      .insertInto('storage_locations')
      .values({
        id: locationId,
        folderName,
        partCount: 1,
        mergedAt: null,
        mergeStartedAt: Date.now(),
        partsDeletedAt: null,
        lastDownloadedAt: null,
      })
      .execute()
    await db
      .insertInto('cache_entries')
      .values({
        id: entryId,
        key: randomUUID(),
        version: 'v1',
        scope: 'refs/heads/main',
        repoId: '123',
        updatedAt: Date.now(),
        locationId,
      })
      .execute()
    await db
      .insertInto('merge_leases')
      .values({
        storageLocationId: locationId,
        token: randomUUID(),
        expiresAt: Date.now() + 60_000,
      })
      .execute()

    vi.useFakeTimers()
    try {
      const download = await storage.download(entryId)
      expect(download).toBeDefined()
      download!.on('error', () => undefined)
      await db
        .deleteFrom('storage_reader_leases')
        .where('storageLocationId', '=', locationId)
        .execute()

      await vi.advanceTimersByTimeAsync(30_000)

      expect(download!.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
      await db.deleteFrom('storage_locations').where('id', '=', locationId).execute()
      await storage.adapter.deleteFolder(folderName)
    }
  })

  test('failed upload finalization removes the upload folder after its database record', async () => {
    const storage = await Storage.fromEnv()
    const key = randomUUID()
    const upload = await storage.createUpload({
      key,
      version: 'v1',
      scope: 'refs/heads/main',
      repoId: '123',
    })
    expect(upload).toBeDefined()
    await storage.adapter.uploadStream(`${upload!.id}/untracked`, Readable.from('partial'))

    await expect(
      storage.completeUpload({ key, version: 'v1', scope: 'refs/heads/main', repoId: '123' }),
    ).rejects.toThrow('No parts have been uploaded')
    expect(await storage.adapter.countFilesInFolder(upload!.id.toString())).toBe(0)
  })
})
