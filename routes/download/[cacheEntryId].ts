import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { logger } from '~/lib/logger'
import { getStorage } from '~/lib/storage'

const pathParamsSchema = z.object({
  cacheEntryId: z.string(),
})

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid path parameters: ${parsedPathParams.error.message}`,
    })

  const { cacheEntryId } = parsedPathParams.data

  const storage = await getStorage()
  const stream = await storage.download(cacheEntryId)
  if (!stream)
    throw createError({
      statusCode: 404,
      message: 'Cache file not found',
    })

  // Not h3's `sendStream`: its web-stream path neither applies backpressure nor
  // notices the client hanging up, so an aborted download keeps draining the
  // backend read into a socket nobody is reading. `pipeline` destroys the
  // source when the response closes, which also releases the reader lease the
  // stream carries.
  event._handled = true
  try {
    await pipeline(stream, event.node.res)
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
