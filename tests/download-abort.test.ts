import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { describe, expect, test, vi } from 'vitest'

/**
 * A source that never ends on its own, and records being destroyed. Stands in
 * for the adapter's backend read (an S3 GET, a file read): the thing that must
 * stop when the client goes away.
 */
function endlessSource() {
  const state = { destroyed: false, pushed: 0 }
  // Paced and unending, so an abort lands mid-body rather than after the whole
  // object has already been buffered out.
  async function* chunks() {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      state.pushed += 1
      yield Buffer.alloc(64 * 1024)
    }
  }
  const stream = Readable.from(chunks(), { highWaterMark: 16 * 1024 })
  stream.on('close', () => (state.destroyed = stream.destroyed))
  return { stream, state }
}

async function serveOnce(handler: (res: import('node:http').ServerResponse) => void) {
  const server = createServer((_req, res) => handler(res))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://localhost:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * Regression for the leak this route used to have: h3's `sendStream` hands the
 * body to a web stream that neither applies backpressure nor notices the client
 * hanging up, so an aborted download keeps draining the backend read into a
 * socket nobody is reading — one leaked backend GET per abort, and the reader
 * lease attached to that stream held until it expires instead of being released
 * on close.
 */
describe('aborted download', () => {
  test('piping with stream.pipeline destroys the source when the client aborts', async () => {
    const { stream, state } = endlessSource()
    const fixture = await serveOnce((res) => {
      void pipeline(stream, res).catch(() => {
        // ERR_STREAM_PREMATURE_CLOSE — the client went away, nothing to report.
      })
    })

    try {
      const controller = new AbortController()
      const res = await fetch(fixture.url, { signal: controller.signal })
      const reader = res.body!.getReader()
      await reader.read()
      controller.abort()
      await reader.cancel().catch(() => {})

      await vi.waitFor(() => expect(state.destroyed).toBe(true), { timeout: 5000, interval: 25 })
    } finally {
      await fixture.close()
    }
  })
})
