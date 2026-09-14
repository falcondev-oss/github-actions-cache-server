import type { RangeRequest } from '~/lib/storage'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { logger } from '~/lib/logger'
import { getStorage, RangeNotSatisfiableError } from '~/lib/storage'

const pathParamsSchema = z.object({
  cacheEntryId: z.string(),
})

// Single ranges only; multi-range and suffix (`bytes=-500`) fall through to a 200.
const RANGE_RE = /^bytes=(\d+)-(\d*)$/i

function parseRange(header: string | undefined): RangeRequest | undefined {
  if (!header) return
  const m = RANGE_RE.exec(header.trim())
  if (!m) return
  const start = Number(m[1])
  if (!Number.isSafeInteger(start)) return
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

  const range = parseRange(getHeader(event, 'range'))

  // Unmerged entries ignore Range, so clients must key off the status, not this header.
  setHeader(event, 'accept-ranges', 'bytes')

  let download
  try {
    download = await storage.download(cacheEntryId, range)
  } catch (err) {
    if (err instanceof RangeNotSatisfiableError) {
      // An empty object has no satisfiable range, but S3 answers `bytes=0-` with an
      // empty 200 while the other adapters raise. Normalise to the 200 so the
      // response does not depend on which backend is configured.
      if (err.size === 0) {
        setHeader(event, 'content-length', 0)
        return send(event)
      }
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

  // Take over the response from h3: `sendStream` applies no backpressure and does not
  // notice client aborts, whereas `pipeline` destroys the source and releases its lease.
  // `_handled` is an h3 v1 internal and will need replacing when h3 v2 lands.
  event._handled = true
  try {
    await pipeline(download.stream, event.node.res)
  } catch (err) {
    // Client went away mid-body. Expected on cancelled jobs and parallel runners.
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.debug(`Client aborted /download/${cacheEntryId}: ${(err as Error).message}`)
      return
    }
    // Headers are out, so Nitro's error handler would crash with ERR_HTTP_HEADERS_SENT.
    if (event.node.res.headersSent) {
      logger.error(`Download stream failed for ${cacheEntryId}`, { error: err })
      return
    }
    throw err
  }
})
