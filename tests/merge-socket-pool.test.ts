import type { Env } from '~/lib/schemas'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, test } from 'vitest'
import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { Storage } from '~/lib/storage'

const MiB = 1024 * 1024
const POOL = 4
const scope = { version: 'v1', scope: 'refs/heads/main', repoId: '123' }
const s3Env = env as Extract<Env, { STORAGE_DRIVER: 's3' }>

async function uploadEntry(storage: Storage, parts: Buffer[]) {
  const key = `merge-pool-${randomUUID()}`
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

async function sha256(stream: Readable) {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

// A first restore merges its parts while it streams them: it holds a part
// GetObject open and needs another S3 socket to upload the merged object. With
// one shared pool, as many concurrent first restores as sockets each hold a GET
// and wait for an upload socket that never frees, so every restore and every
// later S3 call (lookup HEADs included) hangs.
describe.skipIf(process.env.VITEST_STORAGE_DRIVER !== 's3')('merges and the S3 socket pool', () => {
  const originalMaxSockets = s3Env.STORAGE_S3_MAX_SOCKETS
  const originalEagerMerge = env.EAGER_MERGE
  afterEach(() => {
    s3Env.STORAGE_S3_MAX_SOCKETS = originalMaxSockets
    env.EAGER_MERGE = originalEagerMerge
  })

  // A deadlock never settles, so it fails as a test timeout.
  test(
    'as many concurrent first restores as pool sockets complete and merge',
    { timeout: 60_000 },
    async () => {
      env.EAGER_MERGE = false
      s3Env.STORAGE_S3_MAX_SOCKETS = POOL
      const storage = await Storage.fromEnv()

      // Parts above lib-storage's 5 MiB part size, so each merge is a multipart upload.
      const parts = [Buffer.alloc(6 * MiB, 'a'), Buffer.alloc(6 * MiB, 'b')]
      const expected = createHash('sha256').update(Buffer.concat(parts)).digest('hex')
      const entries = []
      for (let i = 0; i < POOL; i++) entries.push(await uploadEntry(storage, parts))

      try {
        const digests = await Promise.all(
          entries.map(async ({ locationId }) => {
            const download = await storage.download(locationId)
            if (!download) throw new Error(`location ${locationId} not found`)
            return sha256(download.stream)
          }),
        )
        expect(digests).toEqual(entries.map(() => expected))

        await storage.waitForOngoingMerges()
        const db = await getDatabase()
        const merged = await db
          .selectFrom('storage_locations')
          .where(
            'id',
            'in',
            entries.map((e) => e.locationId),
          )
          .where('mergedAt', 'is not', null)
          .select('id')
          .execute()
        expect(merged).toHaveLength(POOL)
      } finally {
        for (const { folderName } of entries) await storage.adapter.deleteFolder(folderName)
      }
    },
  )
})
