import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { getStorage } from '~/lib/storage'

const MiB = 1024 * 1024
const ENTRY_BYTES = 512 * MiB
const CHUNK_BYTES = 64 * 1024
// Stream highWaterMarks are KiBs and loopback socket buffers a few MiB. Holding
// more than this means the route is queueing the body in process memory instead
// of letting TCP flow control pace the faster side.
const MAX_BUFFERED_BYTES = 64 * MiB

// The real route handlers on an in-process h3 app, so the test process is the
// server process and its socket and storage calls are observable.
const router = h3.createRouter({ preemptive: true }) // as Nitro: an `undefined` return ends the response
const server = http.createServer(h3.toNodeListener(h3.createApp().use(router)))

beforeAll(async () => {
  for (const [name, value] of Object.entries(h3)) vi.stubGlobal(name, value)
  // Not static imports: route modules call Nitro auto-imports (`defineEventHandler`,
  // …) at evaluation time, so they can only load after the stubs above.
  const { default: upload } = await import('~/routes/devstoreaccount1/upload/[uploadId].put')
  router.put('/upload/:uploadId', upload)
  const { default: download } = await import('~/routes/download/[locationId]')
  router.get('/download/:locationId', download)
  server.listen(0)
  await once(server, 'listening')
})

afterEach(() => {
  vi.restoreAllMocks()
  server.closeAllConnections()
})

afterAll(async () => {
  vi.unstubAllGlobals()
  server.close()
  await once(server, 'close')
})

/** Resolves once `read()` has not changed for `quietMs`, i.e. the pipe has stalled or finished. */
async function settled(read: () => number, quietMs = 500, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last = read()
  let quietSince = Date.now()
  while (Date.now() < deadline && Date.now() - quietSince < quietMs) {
    await sleep(50)
    if (read() === last) continue
    last = read()
    quietSince = Date.now()
  }
  return last
}

describe('proxy routes apply backpressure', () => {
  test('upload does not buffer a block body that storage is not reading yet', async () => {
    const storage = await getStorage()
    const created = await storage.createUpload({
      key: `backpressure-${randomUUID()}`,
      version: 'v1',
      scope: 'refs/heads/main',
      repoId: '123',
    })

    // Storage that stalls (an S3 UploadPart in flight) and drains only when released.
    const { promise: storageStalled, resolve: releaseStorage } = Promise.withResolvers<void>()
    vi.spyOn(storage.adapter, 'uploadStream').mockImplementation(async (_name, stream) => {
      await storageStalled
      for await (const _chunk of stream);
    })

    const { port } = server.address() as AddressInfo
    const serverSide = once(server, 'request') as Promise<[IncomingMessage, ServerResponse]>
    const req = http.request(`http://localhost:${port}/upload/${created.id}`, {
      method: 'PUT',
      headers: { 'content-length': ENTRY_BYTES },
    })
    const response = once(req, 'response') as Promise<[IncomingMessage]>
    const chunk = Buffer.alloc(CHUNK_BYTES)
    let sent = 0
    const sendAll = (async () => {
      while (sent < ENTRY_BYTES) {
        sent += CHUNK_BYTES
        if (!req.write(chunk)) await once(req, 'drain')
      }
      req.end()
    })()

    await settled(() => sent)
    const sentWhileStalled = sent
    const [serverReq] = await serverSide
    const readWhileStalled = serverReq.socket.bytesRead

    releaseStorage()
    await sendAll
    const [res] = await response
    res.resume()
    expect(res.statusCode).toBe(201)
    expect
      .soft(readWhileStalled, 'bytes read off the socket while storage was stalled')
      .toBeLessThan(MAX_BUFFERED_BYTES)
    expect
      .soft(sentWhileStalled, 'bytes the client got out while storage was stalled')
      .toBeLessThan(MAX_BUFFERED_BYTES)
  }, 60_000)

  test('download does not buffer the entry for a client that stopped reading', async () => {
    let pulled = 0
    function* entry() {
      while (pulled < ENTRY_BYTES) {
        pulled += CHUNK_BYTES
        yield Buffer.alloc(CHUNK_BYTES) // fresh memory per chunk, like a storage read
      }
    }
    const source = Readable.from(entry(), { objectMode: false, highWaterMark: CHUNK_BYTES })
    const storage = await getStorage()
    vi.spyOn(storage, 'download').mockResolvedValue({ stream: source })

    const { port } = server.address() as AddressInfo
    const serverSide = once(server, 'request') as Promise<[IncomingMessage, ServerResponse]>
    const req = http.get(`http://localhost:${port}/download/${randomUUID()}`)
    const [res] = (await once(req, 'response')) as [IncomingMessage]
    expect(res.statusCode).toBe(200)
    let received = 0
    res.once('data', (chunk: Buffer) => {
      received += chunk.length
      res.pause() // the client stops reading but keeps the connection open
    })

    await settled(() => pulled)
    const readAhead = pulled - received
    const [, serverRes] = await serverSide
    const queued = serverRes.writableLength
    req.destroy()

    expect
      .soft(readAhead, 'bytes read from storage but not delivered')
      .toBeLessThan(MAX_BUFFERED_BYTES)
    expect.soft(queued, 'bytes queued in the response').toBeLessThan(MAX_BUFFERED_BYTES)
  }, 60_000)

  test('download destroys the storage stream when the client hangs up', async () => {
    // Never ends on its own, so only the route tearing it down can stop the read
    // (and release the reader lease that `Storage.download` ties to `close`).
    function* endless() {
      while (true) yield Buffer.alloc(CHUNK_BYTES)
    }
    const source = Readable.from(endless(), { objectMode: false, highWaterMark: CHUNK_BYTES })
    const storage = await getStorage()
    vi.spyOn(storage, 'download').mockResolvedValue({ stream: source })

    const { port } = server.address() as AddressInfo
    const req = http.get(`http://localhost:${port}/download/${randomUUID()}`)
    req.on('error', () => undefined)
    const [res] = (await once(req, 'response')) as [IncomingMessage]
    expect(res.statusCode).toBe(200)
    res.once('data', () => req.destroy())

    await vi.waitFor(() => expect(source.destroyed).toBe(true), { timeout: 5000, interval: 50 })
  }, 20_000)

  describe('download idle timeout', () => {
    const originalIdleTimeout = env.DOWNLOAD_IDLE_TIMEOUT_MS
    beforeAll(() => {
      env.DOWNLOAD_IDLE_TIMEOUT_MS = 500
    })
    afterAll(() => {
      env.DOWNLOAD_IDLE_TIMEOUT_MS = originalIdleTimeout
    })

    test.each([
      { response: 'a whole entry', status: 200, range: undefined },
      { response: 'a Range', status: 206, range: { start: 0, end: ENTRY_BYTES - 1 } },
    ])(
      'releases the storage read of a client that stopped reading $response',
      async ({ status, range }) => {
        // Real timers and sockets on purpose: the stall comes from TCP flow control,
        // which fake timers cannot drive.
        let pulled = 0
        function* entry() {
          while (pulled < ENTRY_BYTES) {
            pulled += CHUNK_BYTES
            yield Buffer.alloc(CHUNK_BYTES)
          }
        }
        const source = Readable.from(entry(), { objectMode: false, highWaterMark: CHUNK_BYTES })
        const storage = await getStorage()
        vi.spyOn(storage, 'download').mockResolvedValue({
          stream: source,
          size: ENTRY_BYTES,
          range,
        })

        const { port } = server.address() as AddressInfo
        const serverSide = once(server, 'request') as Promise<[IncomingMessage, ServerResponse]>
        const req = http.get(`http://localhost:${port}/download/${randomUUID()}`, {
          headers: range ? { range: `bytes=${range.start}-${range.end}` } : {},
        })
        req.on('error', () => undefined)
        const [res] = (await once(req, 'response')) as [IncomingMessage]
        expect(res.statusCode).toBe(status)
        res.once('data', () => res.pause()) // stops reading, keeps the connection open
        const [, serverRes] = await serverSide
        const serverClosed = once(serverRes, 'close')

        // Without an idle timeout neither ever happens: the pipe just stays parked.
        await expect(once(source, 'close')).rejects.toMatchObject({
          code: 'ERR_DOWNLOAD_IDLE_TIMEOUT',
        })
        await serverClosed
        expect(pulled).toBeLessThan(ENTRY_BYTES)
        req.destroy()
      },
      20_000,
    )

    test('a stalled first restore is closed and its Merge still completes', async () => {
      const storage = await getStorage()
      const db = await getDatabase()
      const reservation = {
        key: `idle-unmerged-${randomUUID()}`,
        version: 'v1',
        scope: 'refs/heads/main',
        repoId: '123',
      }
      const upload = await storage.createUpload(reservation)
      // Far more than loopback socket buffers hold, so the stalled client really blocks the tee.
      for (let i = 0; i < 4; i++)
        await storage.uploadPart(upload.id, i, Readable.from([Buffer.alloc(8 * MiB, i)]))
      await storage.completeUpload(reservation)
      const { locationId } = await db
        .selectFrom('cache_entries')
        .where('key', '=', reservation.key)
        .select('locationId')
        .executeTakeFirstOrThrow()

      const { port } = server.address() as AddressInfo
      const serverSide = once(server, 'request') as Promise<[IncomingMessage, ServerResponse]>
      const req = http.get(`http://localhost:${port}/download/${locationId}`)
      req.on('error', () => undefined)
      const [res] = (await once(req, 'response')) as [IncomingMessage]
      expect(res.statusCode).toBe(200)
      res.once('data', () => res.pause())
      const [, serverRes] = await serverSide
      await once(serverRes, 'close')
      req.destroy()

      // The pump keeps feeding the merge once the client's side of the tee is gone.
      await storage.waitForOngoingMerges()
      const location = await db
        .selectFrom('storage_locations')
        .where('id', '=', locationId)
        .select('mergedAt')
        .executeTakeFirstOrThrow()
      expect(location.mergedAt).not.toBeNull()
      await vi.waitFor(
        async () => {
          const leases = await db
            .selectFrom('storage_reader_leases')
            .where('storageLocationId', '=', locationId)
            .select('id')
            .execute()
          expect(leases, 'reader leases left behind').toHaveLength(0)
        },
        { timeout: 5000, interval: 50 },
      )
    }, 30_000)
  })
})
