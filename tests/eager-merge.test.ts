import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { Storage } from '~/lib/storage'

const scope = { version: 'v1', scope: 'refs/heads/main', repoId: '123' }

async function uploadParts(storage: Storage, parts: Buffer[]) {
  const key = randomUUID()
  const upload = await storage.createUpload({ key, ...scope })
  for (const [index, part] of parts.entries())
    await storage.uploadPart(upload!.id, index, Readable.from(part))
  await storage.completeUpload({ key, ...scope })
  const db = await getDatabase()
  return db
    .selectFrom('storage_locations')
    .innerJoin('cache_entries', 'cache_entries.locationId', 'storage_locations.id')
    .where('cache_entries.key', '=', key)
    .selectAll('storage_locations')
    .executeTakeFirstOrThrow()
}

async function mergedBytes(storage: Storage, folderName: string) {
  const stream = await storage.adapter.createDownloadStream(`${folderName}/merged`)
  return Buffer.concat(await stream.toArray())
}

describe('eager merge', () => {
  const originalEagerMerge = env.EAGER_MERGE
  beforeEach(() => {
    env.EAGER_MERGE = true
  })
  afterEach(() => {
    env.EAGER_MERGE = originalEagerMerge
  })

  test('streams parts into the merged object at upload completion', async () => {
    const storage = await Storage.fromEnv()
    const parts = [Buffer.alloc(1024, 'a'), Buffer.alloc(1024, 'b')]

    const location = await uploadParts(storage, parts)
    try {
      await storage.waitForOngoingMerges()
      const db = await getDatabase()
      const current = await db
        .selectFrom('storage_locations')
        .where('id', '=', location.id)
        .select('mergedAt')
        .executeTakeFirstOrThrow()
      expect(current.mergedAt).not.toBeNull()
      const merged = await mergedBytes(storage, location.folderName)
      expect(merged.equals(Buffer.concat(parts))).toBe(true)
    } finally {
      await storage.adapter.deleteFolder(location.folderName)
    }
  })

  test('leaves the merge to the first download when disabled', async () => {
    env.EAGER_MERGE = false
    const storage = await Storage.fromEnv()

    const location = await uploadParts(storage, [Buffer.alloc(1024, 'a')])
    try {
      await storage.waitForOngoingMerges()
      expect(location.mergedAt).toBeNull()
      expect(await storage.adapter.objectExists(`${location.folderName}/merged`)).toBe(false)
    } finally {
      await storage.adapter.deleteFolder(location.folderName)
    }
  })

  test.skipIf((process.env.VITEST_STORAGE_DRIVER ?? 'filesystem') === 'filesystem')(
    'composes parts server-side when they satisfy the backend limits',
    { timeout: 60_000 },
    async () => {
      const storage = await Storage.fromEnv()
      const parts = [Buffer.alloc(5 * 1024 * 1024, 'a'), Buffer.alloc(1024, 'b')]
      const run = vi.spyOn(storage.adapter.composeParts!, 'run')

      const location = await uploadParts(storage, parts)
      try {
        await storage.waitForOngoingMerges()
        expect(run).toHaveBeenCalledOnce()
        const merged = await mergedBytes(storage, location.folderName)
        expect(merged.equals(Buffer.concat(parts))).toBe(true)
      } finally {
        run.mockRestore()
        await storage.adapter.deleteFolder(location.folderName)
      }
    },
  )

  test.skipIf(process.env.VITEST_STORAGE_DRIVER !== 'gcs')(
    'folds more than 32 parts through a temp object and removes it',
    { timeout: 60_000 },
    async () => {
      const storage = await Storage.fromEnv()
      const parts = Array.from({ length: 33 }, (_, index) => Buffer.alloc(1024, String(index % 10)))

      const location = await uploadParts(storage, parts)
      try {
        await storage.waitForOngoingMerges()
        const merged = await mergedBytes(storage, location.folderName)
        expect(merged.equals(Buffer.concat(parts))).toBe(true)
        const folders = await storage.adapter.listStorageFolders()
        expect(folders.filter(({ folderName }) => folderName.startsWith('tmp-'))).toEqual([])
      } finally {
        await storage.adapter.deleteFolder(location.folderName)
      }
    },
  )
})
