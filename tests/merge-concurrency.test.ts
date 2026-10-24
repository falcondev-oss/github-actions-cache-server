import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, test } from 'vitest'
import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { Storage } from '~/lib/storage'

const scope = { version: 'v1', scope: 'refs/heads/main', repoId: '123' }
const parts = [Buffer.alloc(256 * 1024, 'a'), Buffer.alloc(256 * 1024, 'b')]
const expected = createHash('sha256').update(Buffer.concat(parts)).digest('hex')

async function uploadEntry(storage: Storage) {
  const key = `merge-cap-${randomUUID()}`
  const upload = await storage.createUpload({ key, ...scope })
  for (const [index, part] of parts.entries())
    await storage.uploadPart(upload.id, index, Readable.from(part))
  await storage.completeUpload({ key, ...scope })
  const db = await getDatabase()
  return db
    .selectFrom('cache_entries')
    .innerJoin('storage_locations', 'storage_locations.id', 'cache_entries.locationId')
    .where('cache_entries.key', '=', key)
    .select(['storage_locations.id as locationId', 'folderName'])
    .executeTakeFirstOrThrow()
}

async function download(storage: Storage, locationId: string) {
  const result = await storage.download(locationId)
  if (!result) throw new Error(`location ${locationId} not found`)
  return result.stream
}

async function sha256(stream: Readable) {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function mergeState(locationId: string) {
  const db = await getDatabase()
  return db
    .selectFrom('storage_locations')
    .where('id', '=', locationId)
    .select(['mergedAt', 'mergeStartedAt'])
    .executeTakeFirstOrThrow()
}

describe('merge concurrency limit', () => {
  const originalMaxMerges = env.MAX_CONCURRENT_MERGES
  const originalEagerMerge = env.EAGER_MERGE
  afterEach(() => {
    env.MAX_CONCURRENT_MERGES = originalMaxMerges
    env.EAGER_MERGE = originalEagerMerge
  })

  test('a first restore beyond the limit is served from parts without merging', async () => {
    env.EAGER_MERGE = false
    env.MAX_CONCURRENT_MERGES = 1
    const storage = await Storage.fromEnv()
    const first = await uploadEntry(storage)
    const second = await uploadEntry(storage)

    try {
      // The first restore's Merge is paced by its unread stream, so it still
      // holds the only slot when the second restore starts.
      const firstStream = await download(storage, first.locationId)
      const secondStream = await download(storage, second.locationId)
      expect(await sha256(secondStream)).toBe(expected)
      expect(await sha256(firstStream)).toBe(expected)
      await storage.waitForOngoingMerges()

      expect(await mergeState(first.locationId)).not.toMatchObject({ mergedAt: null })
      expect(await mergeState(second.locationId)).toMatchObject({ mergedAt: null })

      // With the slot free again, the next restore merges the skipped entry.
      expect(await sha256(await download(storage, second.locationId))).toBe(expected)
      await storage.waitForOngoingMerges()
      expect(await mergeState(second.locationId)).not.toMatchObject({ mergedAt: null })
    } finally {
      await storage.adapter.deleteFolder(first.folderName)
      await storage.adapter.deleteFolder(second.folderName)
    }
  })

  test('an eager merge beyond the limit leaves the entry to a later download', async () => {
    env.EAGER_MERGE = false
    env.MAX_CONCURRENT_MERGES = 1
    const storage = await Storage.fromEnv()
    const busy = await uploadEntry(storage)
    // An unread first restore keeps its Merge, and the only slot, busy.
    const busyStream = await download(storage, busy.locationId)

    env.EAGER_MERGE = true
    const eager = await uploadEntry(storage)
    try {
      // Upload completion awaits the Merge Lease, so a started Merge would have
      // stamped mergeStartedAt by now.
      expect(await mergeState(eager.locationId)).toEqual({ mergedAt: null, mergeStartedAt: null })

      expect(await sha256(busyStream)).toBe(expected)
      await storage.waitForOngoingMerges()
      expect(await sha256(await download(storage, eager.locationId))).toBe(expected)
      await storage.waitForOngoingMerges()
      expect(await mergeState(eager.locationId)).not.toMatchObject({ mergedAt: null })
    } finally {
      await storage.adapter.deleteFolder(busy.folderName)
      await storage.adapter.deleteFolder(eager.folderName)
    }
  })
})
