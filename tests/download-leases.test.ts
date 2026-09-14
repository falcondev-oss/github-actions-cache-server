import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

import { describe, expect, test, vi } from 'vitest'
import { getDatabase } from '~/lib/db'
import { getStorage } from '~/lib/storage'

const SCOPE = 'refs/heads/main'
const REPO_ID = '123'
const VERSION = 'abort-test-version'
const DOWNLOAD_URL = 'http://localhost:3000/download'

// Big enough that the body is still streaming when the client goes away: the
// abort has to land mid-download for the leak to be observable at all.
const PART_SIZE = 4 * 1024 * 1024
const PART_COUNT = 4

async function createEntry() {
  const storage = await getStorage()
  const key = `abort-${crypto.randomUUID()}`

  const upload = await storage.createUpload({
    key,
    version: VERSION,
    scope: SCOPE,
    repoId: REPO_ID,
  })
  if (!upload) throw new Error('createUpload returned nothing')
  for (let i = 0; i < PART_COUNT; i++) {
    await storage.uploadPart(
      upload.id,
      i,
      Readable.toWeb(Readable.from(crypto.randomBytes(PART_SIZE))),
    )
  }
  await storage.completeUpload({ key, version: VERSION, scope: SCOPE, repoId: REPO_ID })

  const matched = await storage.matchCacheEntry({
    keys: [key],
    version: VERSION,
    scopes: [SCOPE],
    repoId: REPO_ID,
  })
  const id = matched?.match.id
  if (!id) throw new Error('cache entry not found after completeUpload')
  return id
}

async function leaseCount(cacheEntryId: string) {
  const db = await getDatabase()
  const rows = await db
    .selectFrom('storage_reader_leases')
    .innerJoin(
      'storage_locations',
      'storage_locations.id',
      'storage_reader_leases.storageLocationId',
    )
    .innerJoin('cache_entries', 'cache_entries.locationId', 'storage_locations.id')
    .where('cache_entries.id', '=', cacheEntryId)
    .select('storage_reader_leases.id')
    .execute()
  return rows.length
}

/**
 * Lease lifecycle for the download route: the reader lease taken for a download
 * must be gone once the response is over, whether the client read it to the end
 * or hung up partway.
 *
 * This does NOT prove the abort case destroys the backend read. The server runs
 * as its own process, so the adapter's read cannot be observed from here, and
 * `protectDownloadStream` releases the lease on `end` as well as `close` — a
 * body this size finishes on the server regardless of when the client aborts.
 * The leak this route used to have (h3's `sendStream` draining the backend into
 * a socket nobody reads) is not covered by anything here; catching it needs a
 * body that never ends, which the server would have to be asked to produce.
 */
describe('download reader leases', () => {
  test('releases the reader lease when the client aborts mid-body', async () => {
    const cacheEntryId = await createEntry()

    const controller = new AbortController()
    const res = await fetch(`${DOWNLOAD_URL}/${cacheEntryId}`, { signal: controller.signal })
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(await leaseCount(cacheEntryId)).toBe(1)

    controller.abort()
    await reader.cancel().catch(() => {})

    await vi.waitFor(async () => expect(await leaseCount(cacheEntryId)).toBe(0), {
      timeout: 5000,
      interval: 50,
    })
  }, 20_000)

  test('releases the reader lease after a completed download', async () => {
    const cacheEntryId = await createEntry()

    const res = await fetch(`${DOWNLOAD_URL}/${cacheEntryId}`)
    expect(res.status).toBe(200)
    const body = Buffer.from(await res.arrayBuffer())
    expect(body).toHaveLength(PART_SIZE * PART_COUNT)

    await vi.waitFor(async () => expect(await leaseCount(cacheEntryId)).toBe(0), {
      timeout: 5000,
      interval: 50,
    })
  }, 20_000)
})
