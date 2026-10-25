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
import { getStorage } from '~/lib/storage'

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
 * A client can give up on /download while the storage read still waits for a
 * socket. `pipeline` rejects the closed response without taking ownership of the
 * body, so unless the route destroys it, the body pins its backend socket and
 * reader lease for the life of the process.
 */
describe('download for a client that left before storage answered', () => {
  test('releases the backend read and the reader lease', async () => {
    const storage = await getStorage()
    const db = await getDatabase()
    const locationId = await createMergedEntry()

    const { promise: clientGone, resolve: markClientGone } = Promise.withResolvers<void>()
    // An unending body: only being destroyed lets it go, as with a GetObject body.
    const body = Readable.from(
      (async function* () {
        for (;;) {
          await sleep(1)
          yield Buffer.alloc(64 * 1024)
        }
      })(),
    )
    vi.spyOn(storage.adapter, 'createDownloadStream').mockImplementation(async () => {
      await clientGone
      return { stream: body }
    })

    const { port } = server.address() as AddressInfo
    const serverSide = once(server, 'request') as Promise<[IncomingMessage, ServerResponse]>
    const req = http.get(`http://localhost:${port}/download/${locationId}`)
    req.on('error', () => {})
    const [, serverRes] = await serverSide
    req.destroy()
    await once(serverRes, 'close')
    markClientGone()

    await vi.waitFor(
      async () => {
        expect(body.destroyed, 'backend body destroyed').toBe(true)
        const leases = await db
          .selectFrom('storage_reader_leases')
          .where('storageLocationId', '=', locationId)
          .select('id')
          .execute()
        expect(leases, 'reader leases left behind').toHaveLength(0)
      },
      { timeout: 5000, interval: 25 },
    )
  }, 20_000)
})
