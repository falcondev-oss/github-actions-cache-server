import type { RangeRequest } from '~/lib/storage'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { logger } from '~/lib/logger'
import { getStorage, RangeNotSatisfiableError } from '~/lib/storage'

const pathParamsSchema = z.object({
  locationId: z.string(),
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

  const { locationId } = parsedPathParams.data
  const storage = await getStorage()

  const range = parseRange(getHeader(event, 'range'))

  // Unmerged entries ignore Range, so clients must key off the status, not this header.
  setHeader(event, 'accept-ranges', 'bytes')

  let download
  try {
    download = await storage.download(locationId, range)
  } catch (err) {
    if (!(err instanceof RangeNotSatisfiableError)) throw err
    // An empty entry has no satisfiable range. The filesystem and GCS adapters raise
    // for any Range on one and Azure for any start past 0, while RustFS (S3) answers
    // `bytes=0-` with an empty 200. Ignore Range on empty entries (RFC 9110 §14.2) so
    // the response does not depend on the storage driver.
    if (err.size === 0) {
      setHeader(event, 'content-length', 0)
      return send(event)
    }
    setResponseStatus(event, 416, 'Range Not Satisfiable')
    if (err.size !== undefined) setHeader(event, 'content-range', `bytes */${err.size}`)
    return send(event)
  }
  if (!download)
    throw createError({
      statusCode: 404,
      message: 'Cache file not found',
    })

  if (download.range && download.size !== undefined) {
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

  // `sendStream` neither waits for `drain` nor notices client aborts; `pipeline` does both
  // and destroys the source, which releases its reader lease. `_handled` is an h3 v1 internal.
  event._handled = true
  try {
    await pipeline(download.stream, event.node.res)
  } catch (err) {
    // Client went away mid-body. Expected on cancelled jobs and parallel runners.
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.debug(`Client aborted /download/${locationId}: ${(err as Error).message}`)
      return
    }
    // Headers are out, so Nitro's error handler would crash with ERR_HTTP_HEADERS_SENT.
    if (event.node.res.headersSent) {
      logger.error(`Download stream failed for ${locationId}`, { error: err })
      return
    }
    throw err
  }
})
