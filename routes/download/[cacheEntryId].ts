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

  // `sendStream` neither waits for `drain` nor notices client aborts; `pipeline` does both
  // and destroys the source, which releases its reader lease. `_handled` is an h3 v1 internal.
  event._handled = true
  try {
    await pipeline(stream, event.node.res)
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
