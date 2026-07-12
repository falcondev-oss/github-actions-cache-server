import type { StorageAdapter } from '~/lib/storage'
import { randomUUID } from 'node:crypto'

import { Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { getDatabase } from '~/lib/db'
import { logger } from '~/lib/logger'
import { Storage } from '~/lib/storage'
import { reconcileOrphanedStorage, runCleanupTask } from '~/lib/storage-lifecycle'

describe('storage lifecycle reconciliation', () => {
  test('emits an info summary when a cleanup run fails', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const result = { failures: 0, durationMs: 0 }

    await expect(
      runCleanupTask({
        task: 'cleanup:test',
        result,
        async run() {
          throw new Error('cleanup failed')
        },
      }),
    ).rejects.toThrow('cleanup failed')

    expect(info).toHaveBeenCalledWith(
      'Cleanup run completed',
      expect.objectContaining({ task: 'cleanup:test', failures: 1 }),
    )
    info.mockRestore()
    error.mockRestore()
  })

  test('fails closed without deleting when storage inventory cannot complete', async () => {
    const db = await getDatabase()
    let deleteCalls = 0
    const adapter = {
      async createDownloadStream() {
        return Readable.from('')
      },
      async uploadStream() {},
      async objectExists() {
        return false
      },
      async listStorageFolders() {
        throw new Error('incomplete inventory')
      },
      async deleteFolder() {
        deleteCalls++
        return { objects: 0, bytes: 0 }
      },
      async countFilesInFolder() {
        return 0
      },
      async clear() {},
    } satisfies StorageAdapter

    await expect(reconcileOrphanedStorage({ db, adapter, gracePeriodHours: 24 })).rejects.toThrow(
      'incomplete inventory',
    )
    expect(deleteCalls).toBe(0)
  })

  test('reports objects and bytes actually reclaimed by deletion', async () => {
    const db = await getDatabase()
    const adapter = {
      async createDownloadStream() {
        return Readable.from('')
      },
      async uploadStream() {},
      async objectExists() {
        return false
      },
      async listStorageFolders() {
        return [{ folderName: 'orphan-under-write', objectCount: 99, bytes: 999, updatedAt: 0 }]
      },
      async deleteFolder() {
        return { objects: 2, bytes: 5 }
      },
      async countFilesInFolder() {
        return 0
      },
      async clear() {},
    } satisfies StorageAdapter

    const result = await reconcileOrphanedStorage({ db, adapter, gracePeriodHours: 24 })

    expect(result).toMatchObject({ deletedFolders: 1, deletedObjects: 2, deletedBytes: 5 })
  })

  test('deletes grace-expired orphaned folders and retains database-authorized folders', async () => {
    const db = await getDatabase()
    const adapter = await Storage.getAdapterFromEnv()
    const authorizedFolder = `authorized-${randomUUID()}`
    const orphanedFolder = `orphaned-${randomUUID()}`
    const uploadId = Math.floor(Math.random() * 1_000_000_000)

    await db
      .insertInto('uploads')
      .values({
        id: uploadId,
        key: randomUUID(),
        version: 'v1',
        scope: 'refs/heads/main',
        repoId: '123',
        createdAt: Date.now(),
        lastPartUploadedAt: null,
        folderName: authorizedFolder,
        startedPartUploadCount: 0,
        finishedPartUploadCount: 0,
      })
      .execute()

    try {
      await adapter.uploadStream(`${authorizedFolder}/parts/0`, Readable.from('authorized'))
      await adapter.uploadStream(`${orphanedFolder}/parts/0`, Readable.from('orphaned'))

      const result = await reconcileOrphanedStorage({
        db,
        adapter,
        gracePeriodHours: 24,
        now: Date.now() + 25 * 60 * 60 * 1000,
      })

      expect(result).toMatchObject({
        inspectedFolders: expect.any(Number),
        deletedFolders: 1,
        deletedObjects: 1,
        failures: 0,
      })
      expect(await adapter.countFilesInFolder(`${authorizedFolder}/parts`)).toBe(1)
      expect(await adapter.countFilesInFolder(`${orphanedFolder}/parts`)).toBe(0)
    } finally {
      await db.deleteFrom('uploads').where('id', '=', uploadId).execute()
      await adapter.deleteFolder(authorizedFolder)
      await adapter.deleteFolder(orphanedFolder)
    }
  })
})
