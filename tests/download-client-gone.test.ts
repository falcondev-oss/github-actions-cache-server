import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import { Readable } from 'node:stream'

import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { getDatabase } from '~/lib/db'
import { getStorage } from '~/lib/storage'

/**
 * A stand-in for the object store: answers every GET with an unending body, so
 * a response only gives its socket back by being read to the end or destroyed.
 */
async function startOrigin() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    const chunk = Buffer.alloc(64 * 1024)
    const pump = () => {
      while (!res.destroyed && res.write(chunk));
    }
    res.on('drain', pump)
    pump()
  })
  server.listen(0)
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    url: `http://localhost:${port}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

// The real route on an in-process h3 app, as in proxy-backpressure.test.ts, so
// the storage it calls and the sockets it holds are observable here.
const router = h3.createRouter({ preemptive: true })
const server = http.createServer(h3.toNodeListener(h3.createApp().use(router)))

beforeAll(async () => {
  for (const [name, value] of Object.entries(h3)) vi.stubGlobal(name, value)
  // Not a static import: the route calls Nitro auto-imports at evaluation time,
  // so it can only load after the stubs above.
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

async function createMergedEntry() {
  const storage = await getStorage()
  const db = await getDatabase()
  const key = `client-gone-${randomUUID()}`
  const entry = { key, version: 'v1', scope: 'refs/heads/main', repoId: '123' }
  const upload = await storage.createUpload(entry)
  await storage.uploadPart(upload.id, 0, Readable.from('payload'))
  await storage.completeUpload(entry)
  const { locationId } = await db
    .selectFrom('cache_entries')
    .where('key', '=', key)
    .select('locationId')
    .executeTakeFirstOrThrow()
  // Merged, so download() goes straight to one read of the merged object.
  await db
    .updateTable('storage_locations')
    .set({ mergedAt: Date.now() })
    .where('id', '=', locationId)
    .execute()
  return locationId
}

/**
 * A client can give up on /download while the storage read is still waiting
 * for a socket in a saturated pool. The body then arrives for a response that
 * is already closed, and `pipeline` rejects a closed destination
 * (ERR_STREAM_UNABLE_TO_PIPE) before it takes ownership of the source. Unless
 * the route destroys it, the body pins its backend socket and reader lease for
 * the life of the process.
 */
describe('download for a client that left before storage answered', () => {
  test('releases the backend socket and the reader lease', async () => {
    const origin = await startOrigin()
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const storage = await getStorage()
    const db = await getDatabase()
    const locationId = await createMergedEntry()

    const { promise: clientGone, resolve: markClientGone } = Promise.withResolvers<void>()
    const { promise: adapterSettled, resolve: markAdapterSettled } = Promise.withResolvers<void>()
    let body: IncomingMessage | undefined
    vi.spyOn(storage.adapter, 'createDownloadStream').mockImplementation(async () => {
      try {
        await clientGone
        const req = http.get(origin.url, { agent })
        const [res] = (await once(req, 'response')) as [IncomingMessage]
        body = res
        return { stream: res }
      } finally {
        markAdapterSettled()
      }
    })

    try {
      const { port } = server.address() as AddressInfo
      const serverSide = once(server, 'request') as Promise<[IncomingMessage, ServerResponse]>
      const req = http.get(`http://localhost:${port}/download/${locationId}`)
      req.on('error', () => {})
      const [, serverRes] = await serverSide
      req.destroy()
      await once(serverRes, 'close')
      markClientGone()
      await adapterSettled

      expect(body).toBeDefined()
      await vi.waitFor(
        () => {
          expect(
            Object.values(agent.sockets).flat(),
            'sockets held for the gone client',
          ).toHaveLength(0)
          expect(body!.destroyed, 'backend body destroyed').toBe(true)
        },
        { timeout: 5000, interval: 25 },
      )
      await vi.waitFor(
        async () => {
          const leases = await db
            .selectFrom('storage_reader_leases')
            .where('storageLocationId', '=', locationId)
            .select('id')
            .execute()
          expect(leases, 'reader leases left behind').toHaveLength(0)
        },
        { timeout: 5000, interval: 25 },
      )
    } finally {
      agent.destroy()
      await origin.close()
    }
  }, 20_000)
})
