import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

import { describe, expect, test } from 'vitest'
import { getStorage } from '~/lib/storage'

const SCOPE = 'refs/heads/main'
const REPO_ID = '123'
const VERSION = 'concurrent-test-version'

async function drain(stream: Readable | undefined) {
  if (!stream) throw new Error('download returned no stream (cache miss)')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

describe('concurrent downloads of the same unmerged entry', () => {
  test(
    'concurrent readers all get the full payload and the merge keeps parts (no inline delete)',
    { timeout: 30_000 },
    async () => {
      const storage = await getStorage()

      // Build a fresh multi-part (unmerged) entry directly via the storage API.
      const key = `concurrent-${crypto.randomUUID()}`
      const part0 = crypto.randomBytes(512 * 1024)
      const part1 = crypto.randomBytes(512 * 1024)
      const expected = Buffer.concat([part0, part1])

      const upload = await storage.createUpload({
        key,
        version: VERSION,
        scope: SCOPE,
        repoId: REPO_ID,
      })
      if (!upload) throw new Error('createUpload returned nothing')
      await storage.uploadPart(upload.id, 0, Readable.toWeb(Readable.from(part0)))
      await storage.uploadPart(upload.id, 1, Readable.toWeb(Readable.from(part1)))
      await storage.completeUpload({ key, version: VERSION, scope: SCOPE, repoId: REPO_ID })

      const matched = await storage.matchCacheEntry({
        keys: [key],
        version: VERSION,
        scopes: [SCOPE],
        repoId: REPO_ID,
      })
      const cacheEntryId = matched?.match.id
      if (!cacheEntryId) throw new Error('cache entry not found after completeUpload')

      // Fire many concurrent downloads of the still-unmerged entry. Each must
      // receive the full payload, served directly from the parts.
      const results = await Promise.all(
        Array.from({ length: 8 }, async () => drain(await storage.download(cacheEntryId))),
      )
      for (const body of results) expect(body.compare(expected)).toBe(0)

      await storage.waitForOngoingMerges()

      // The merge must NOT delete the parts inline — that is the deletion race
      // (deleting parts out from under in-flight readers). Deletion is the
      // `cleanup:parts` task's job, so the parts must still be present here.
      // The original inline-delete code wipes them on first download, so this
      // asserts the fix. `folderName` is the upload id (see createUpload).
      const partsRemaining = await storage.adapter.countFilesInFolder(`${upload.id}/parts`)
      expect(partsRemaining).toBe(2)

      // The single background merge must have produced a valid merged blob,
      // and an already-merged entry must serve it.
      const afterMerge = await drain(await storage.download(cacheEntryId))
      expect(afterMerge.compare(expected)).toBe(0)
      const mergedBlob = await drain(
        await storage.adapter.createDownloadStream(`${upload.id}/merged`),
      )
      expect(mergedBlob.compare(expected)).toBe(0)
    },
  )
})
