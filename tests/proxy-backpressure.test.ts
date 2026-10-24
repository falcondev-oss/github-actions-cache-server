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
})
