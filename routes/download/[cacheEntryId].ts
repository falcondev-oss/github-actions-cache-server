import type { RangeRequest } from '~/lib/storage'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { logger } from '~/lib/logger'
import { getStorage, RangeNotSatisfiableError } from '~/lib/storage'

const pathParamsSchema = z.object({
  cacheEntryId: z.string(),
})

/**
 * `Range: bytes=<start>-<end>`, where `end` may be omitted.
 *
 * Deliberately narrow: this serves one range, not the multi-range or suffix
 * (`bytes=-500`) forms the RFC also allows. Clients of this server ask for
 * closed `start-end` blocks or an open-ended tail and nothing else, and
 * anything unrecognised falls through to a normal 200 with the whole object,
 * which is always correct.
 */
// The range unit is case-insensitive per RFC 9110 section 14.1.
const RANGE_RE = /^bytes=(\d+)-(\d*)$/i

function parseRange(header: string | undefined): RangeRequest | undefined {
  if (!header) return
  const m = RANGE_RE.exec(header.trim())
  if (!m) return
  const start = Number(m[1])
  if (!Number.isSafeInteger(start)) return
  // Open-ended stays open-ended: the backend resolves the end against the
  // object, so the length is never needed here and no HEAD is ever issued.
  if (m[2] === '') return { start }
  const end = Number(m[2])
  if (!Number.isSafeInteger(end) || end < start) return
  return { start, end }
}

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid path parameters: ${parsedPathParams.error.message}`,
    })

  const { cacheEntryId } = parsedPathParams.data
  const storage = await getStorage()

  // Why this route understands Range at all: `@actions/cache` picks its
  // download strategy from the URL's HOSTNAME. `.blob.core.windows.net` gets
  // the concurrent, ranged downloader; everything else gets a single
  // `httpClient.get()` with no Range and no keep-alive (actions/toolkit,
  // packages/cache/src/internal/cacheHttpClient.ts). A self-hosted server can
  // never match that hostname, so its clients are pinned to one stream no
  // matter how much bandwidth is on the wire. Measured on one runner pod
  // against one 320 MB object: ~15 MB/s as shipped, 143 MB/s over 8 parallel
  // ranges. Serving Range here is what lets a range-capable client reach that
  // without handing object-store credentials to the job — the credentials stay
  // in this process, which is the point of proxying rather than presigning.
  const range = parseRange(getHeader(event, 'range'))

  // Advertised even on whole-object responses so a client can discover support
  // from any prior request instead of probing. An UNMERGED entry is streamed
  // from its Parts and ignores Range (200, full body), so a client must key off
  // the response status, not this header.
  setHeader(event, 'accept-ranges', 'bytes')

  let download
  try {
    download = await storage.download(cacheEntryId, range)
  } catch (err) {
    if (err instanceof RangeNotSatisfiableError) {
      setResponseStatus(event, 416, 'Range Not Satisfiable')
      if (err.size !== undefined) setHeader(event, 'content-range', `bytes */${err.size}`)
      return send(event)
    }
    throw err
  }
  if (!download)
    throw createError({
      statusCode: 404,
      message: 'Cache file not found',
    })

  if (range && download.range && download.size !== undefined) {
    // 206 only when the adapter actually served the (clamped) range. These
    // headers are how a ranged client learns the total size and verifies each
    // part, so they must describe exactly what is on the wire.
    setResponseStatus(event, 206)
    setHeader(
      event,
      'content-range',
      `bytes ${download.range.start}-${download.range.end}/${download.size}`,
    )
    setHeader(event, 'content-length', download.range.end - download.range.start + 1)
  } else if (download.size !== undefined) {
    setHeader(event, 'content-length', download.size)
  }

  // Not h3's `sendStream`: its web-stream path neither applies backpressure nor
  // notices the client hanging up, so an aborted download keeps draining the
  // backend read into a socket nobody is reading. `pipeline` destroys the
  // source when the response closes, which also releases the reader lease the
  // stream carries.
  event._handled = true
  try {
    await pipeline(download.stream, event.node.res)
  } catch (err) {
    // The client went away mid-body. Expected on long downloads (cancelled
    // jobs, parallel runners) and there is nowhere left to report it.
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.debug(`Client aborted /download/${cacheEntryId}: ${(err as Error).message}`)
      return
    }
    // Headers are already out, so this cannot become an HTTP error response;
    // Nitro's handler would call `setResponseHeaders` after the fact and crash
    // with ERR_HTTP_HEADERS_SENT.
    if (event.node.res.headersSent) {
      logger.error(`Download stream failed for ${cacheEntryId}`, { error: err })
      return
    }
    throw err
  }
})
