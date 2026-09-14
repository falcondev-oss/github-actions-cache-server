import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

import { describe, expect, test } from 'vitest'
import { getStorage } from '~/lib/storage'

const SCOPE = 'refs/heads/main'
const REPO_ID = '123'
const VERSION = 'range-test-version'
const DOWNLOAD_URL = 'http://localhost:3000/download'

// Odd size on purpose: not a multiple of any chunk size a client would pick.
const PART_SIZE = 512 * 1024
const TOTAL = 2 * PART_SIZE + 12_345

async function createEntry() {
  const storage = await getStorage()
  const key = `range-${crypto.randomUUID()}`
  const part0 = crypto.randomBytes(PART_SIZE)
  const part1 = crypto.randomBytes(PART_SIZE)
  const part2 = crypto.randomBytes(TOTAL - 2 * PART_SIZE)
  const expected = Buffer.concat([part0, part1, part2])

  const upload = await storage.createUpload({
    key,
    version: VERSION,
    scope: SCOPE,
    repoId: REPO_ID,
  })
  if (!upload) throw new Error('createUpload returned nothing')
  await storage.uploadPart(upload.id, 0, Readable.toWeb(Readable.from(part0)))
  await storage.uploadPart(upload.id, 1, Readable.toWeb(Readable.from(part1)))
  await storage.uploadPart(upload.id, 2, Readable.toWeb(Readable.from(part2)))
  await storage.completeUpload({ key, version: VERSION, scope: SCOPE, repoId: REPO_ID })

  const matched = await storage.matchCacheEntry({
    keys: [key],
    version: VERSION,
    scopes: [SCOPE],
    repoId: REPO_ID,
  })
  const id = matched?.match.id
  if (!id) throw new Error('cache entry not found after completeUpload')
  return { id, expected, storage }
}

async function createMergedEntry() {
  const entry = await createEntry()
  // First download of an unmerged entry starts the merge in the background.
  const first = await entry.storage.download(entry.id)
  for await (const _ of first!.stream) {
    /* drain */
  }
  await entry.storage.waitForOngoingMerges()
  return entry
}

async function get(id: string, range?: string) {
  const res = await fetch(`${DOWNLOAD_URL}/${id}`, {
    headers: range ? { range } : {},
  })
  const body = Buffer.from(await res.arrayBuffer())
  return { res, body }
}

describe('proxy download route serves HTTP Range on merged entries', () => {
  test('no Range: 200, full body, content-length, accept-ranges', async () => {
    const { id, expected } = await createMergedEntry()
    const { res, body } = await get(id)
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe(String(TOTAL))
    expect(body.compare(expected)).toBe(0)
  })

  test('closed range: 206 with exact content-range and content-length', async () => {
    const { id, expected } = await createMergedEntry()
    const { res, body } = await get(id, 'bytes=4096-8191')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 4096-8191/${TOTAL}`)
    expect(res.headers.get('content-length')).toBe('4096')
    expect(body.compare(expected.subarray(4096, 8192))).toBe(0)
  })

  test('open-ended range is clamped to the object', async () => {
    const { id, expected } = await createMergedEntry()
    const start = TOTAL - 100
    const { res, body } = await get(id, `bytes=${start}-`)
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes ${start}-${TOTAL - 1}/${TOTAL}`)
    expect(body.compare(expected.subarray(start))).toBe(0)
  })

  test('closed range past the end is clamped, not rejected', async () => {
    const { id, expected } = await createMergedEntry()
    const start = TOTAL - 10
    const { res, body } = await get(id, `bytes=${start}-${TOTAL + 5000}`)
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes ${start}-${TOTAL - 1}/${TOTAL}`)
    expect(body.compare(expected.subarray(start))).toBe(0)
  })

  test('range starting at the end: 416 with content-range bytes */size', async () => {
    const { id } = await createMergedEntry()
    const { res } = await get(id, `bytes=${TOTAL}-`)
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${TOTAL}`)
  })

  test('unparseable Range falls through to a plain 200', async () => {
    const { id, expected } = await createMergedEntry()
    const { res, body } = await get(id, 'bytes=abc')
    expect(res.status).toBe(200)
    expect(body.compare(expected)).toBe(0)
  })
})

describe('proxy download route on unmerged entries', () => {
  test('range is ignored: 200 with the full body streamed from parts', async () => {
    const { id, expected } = await createEntry()
    const { res, body } = await get(id, 'bytes=0-10')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-range')).toBeNull()
    expect(body.compare(expected)).toBe(0)
  })
})
