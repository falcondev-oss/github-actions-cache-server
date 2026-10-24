import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { getDatabase } from '~/lib/db'
import { getStorage } from '~/lib/storage'

const PART_COUNT = 3
const PART_BYTES = 1024 * 1024

async function createUnmergedEntry() {
  const storage = await getStorage()
  const db = await getDatabase()
  const key = `merge-sink-gone-${randomUUID()}`
  const entry = { key, version: 'v1', scope: 'refs/heads/main', repoId: '123' }
  const upload = await storage.createUpload(entry)
  if (!upload) throw new Error('createUpload returned nothing')
  for (let i = 0; i < PART_COUNT; i++)
    await storage.uploadPart(upload.id, i, Readable.from([Buffer.alloc(PART_BYTES, i)]))
  await storage.completeUpload(entry)
  return db
    .selectFrom('cache_entries')
    .where('key', '=', key)
    .select('locationId')
    .executeTakeFirstOrThrow()
}

/** Records every part stream the download opens, so the test can see each one released. */
async function trackPartStreams() {
  const storage = await getStorage()
  const original = storage.adapter.createDownloadStream.bind(storage.adapter)
  const parts: Readable[] = []
  vi.spyOn(storage.adapter, 'createDownloadStream').mockImplementation(async (name, range) => {
    const download = await original(name, range)
    if (name.includes('/parts/')) parts.push(download.stream)
    return download
  })
  return parts
}

/** Fails the background merge upload without reading it, as a broken S3 upload would. */
async function failMergeUpload() {
  const storage = await getStorage()
  vi.spyOn(storage.adapter, 'uploadStream').mockRejectedValue(new Error('merge upload failed'))
}

/** Reads one chunk, then hangs up the way the route does when the client leaves. */
async function leaveAfterFirstChunk(stream: Readable) {
  await once(stream, 'readable')
  expect(stream.read()).not.toBeNull()
  stream.destroy()
}

async function settles(promise: Promise<unknown>, timeoutMs = 5000) {
  return Promise.race([promise.then(() => 'settled'), sleep(timeoutMs, 'still pending')])
}

async function locationState(locationId: string) {
  const db = await getDatabase()
  const { mergedAt } = await db
    .selectFrom('storage_locations')
    .where('id', '=', locationId)
    .select('mergedAt')
    .executeTakeFirstOrThrow()
  const mergeLeases = await db
    .selectFrom('merge_leases')
    .where('storageLocationId', '=', locationId)
    .select('token')
    .execute()
  return { mergedAt, mergeLeases }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * The first download of an unmerged entry tees its parts into the client
 * response and the background merge upload. When one of them is destroyed
 * (client hung up, merge upload failed), a pump waiting for 'drain' parks
 * forever: a destroyed stream emits neither 'drain' nor 'error'. That holds the
 * part's backend read (an S3 socket), starves the merge, and keeps renewing
 * the merge lease for the life of the process.
 */
describe('first download of an unmerged entry', () => {
  test('client leaving mid-stream still completes the merge and releases the parts', async () => {
    const storage = await getStorage()
    const { locationId } = await createUnmergedEntry()
    const parts = await trackPartStreams()

    const download = await storage.download(locationId)
    if (!download) throw new Error('download returned nothing')
    const { stream } = download
    await leaveAfterFirstChunk(stream)

    expect(await settles(storage.waitForOngoingMerges()), 'merge settled').toBe('settled')
    const { mergedAt, mergeLeases } = await locationState(locationId)
    expect(mergedAt, 'merge completed').not.toBeNull()
    expect(mergeLeases, 'merge lease released').toHaveLength(0)
    expect(parts).toHaveLength(PART_COUNT)
    expect(
      parts.filter((part) => !part.destroyed),
      'part streams left open',
    ).toHaveLength(0)
  }, 20_000)

  test('a failed merge upload still serves the whole entry to the client', async () => {
    const storage = await getStorage()
    const { locationId } = await createUnmergedEntry()
    await failMergeUpload()

    const download = await storage.download(locationId)
    if (!download) throw new Error('download returned nothing')
    const { stream } = download
    let received = 0
    const consumed = (async () => {
      for await (const chunk of stream) received += (chunk as Buffer).length
    })()

    expect(await settles(consumed), 'client download finished').toBe('settled')
    expect(received).toBe(PART_COUNT * PART_BYTES)
    expect(await settles(storage.waitForOngoingMerges()), 'merge settled').toBe('settled')
    const { mergedAt, mergeLeases } = await locationState(locationId)
    expect(mergedAt, 'failed merge not marked complete').toBeNull()
    expect(mergeLeases, 'merge lease released').toHaveLength(0)
  }, 20_000)

  test('client and merge both gone stops reading and destroys the part stream', async () => {
    const storage = await getStorage()
    const { locationId } = await createUnmergedEntry()
    await failMergeUpload()
    // An unending part: only being destroyed lets it go, as with a GetObject body.
    const part = Readable.from(
      (async function* () {
        for (;;) {
          await sleep(1)
          yield Buffer.alloc(64 * 1024)
        }
      })(),
    )
    vi.spyOn(storage.adapter, 'createDownloadStream').mockResolvedValue({ stream: part })

    const download = await storage.download(locationId)
    if (!download) throw new Error('download returned nothing')
    const { stream } = download
    await leaveAfterFirstChunk(stream)

    await vi.waitFor(() => expect(part.destroyed, 'part stream destroyed').toBe(true), {
      timeout: 5000,
      interval: 25,
    })
    expect(await settles(storage.waitForOngoingMerges()), 'merge settled').toBe('settled')
    const { mergeLeases } = await locationState(locationId)
    expect(mergeLeases, 'merge lease released').toHaveLength(0)
  }, 20_000)
})
