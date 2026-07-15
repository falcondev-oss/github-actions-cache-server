import type { StorageAdapter } from '~/lib/storage'
import { PassThrough, Readable, Writable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { Storage } from '~/lib/storage'

function pacedSink (delayMs: number, onByte: (n: number) => void) {
  return new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _enc, cb) {
      onByte(chunk.length)
      setTimeout(cb, delayMs)
    },
  })
}

// Regression for #247: `download()` tees one part source into the client
// response and the background merge upload. If those two sinks are consumed at
// different rates, awaiting their `drain` events sequentially can miss the
// second stream's `drain` (it fires while parked on the first), deadlocking the
// pump — the client hangs forever mid-download and the merge never completes.
describe('download merge backpressure', () => {
  test('does not deadlock when the two sinks drain at different rates', async () => {
    const PART_COUNT = 3
    const PART_BYTES = 512 * 1024
    const total = PART_COUNT * PART_BYTES

    const adapter = {
      createDownloadStream() {
        const buf = Buffer.alloc(PART_BYTES, 1)
        function* chunked() {
          for (let o = 0; o < buf.length; o += 64 * 1024) yield buf.subarray(o, o + 64 * 1024)
        }
        return Promise.resolve(Readable.from(chunked()))
      },
    } as unknown as StorageAdapter

    const storage = new (Storage as any)({ db: {}, adapter }) as {
      pumpPartsToStreams: (loc: unknown, r: PassThrough, m: PassThrough) => Promise<void>
    }

    const responseStream = new PassThrough({ highWaterMark: 16 * 1024 })
    const mergerStream = new PassThrough({ highWaterMark: 16 * 1024 })

    let responseBytes = 0
    let mergerBytes = 0
    // slow client vs fast merge consumer — the interleaving that triggers the race
    responseStream.pipe(pacedSink(20, (n) => (responseBytes += n)))
    mergerStream.pipe(pacedSink(1, (n) => (mergerBytes += n)))

    const location = {
      folderName: 'x',
      partCount: PART_COUNT,
      mergedAt: null,
      partsDeletedAt: null,
    }

    const deadline = new Promise<'timeout'>((res) => setTimeout(res, 5000, 'timeout'))
    const result = await Promise.race([
      storage.pumpPartsToStreams(location, responseStream, mergerStream).then(() => 'done'),
      deadline,
    ])
    await new Promise((r) => setTimeout(r, 100))

    expect(result).toBe('done')
    expect(responseBytes).toBe(total)
    expect(mergerBytes).toBe(total)
  })
})
