import { Readable } from 'node:stream'
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

  try {
    await sendStream(event, Readable.toWeb(stream) as ReadableStream)
  } catch (err) {
    // Once the response has started flushing, we can't surface stream errors
    // as an HTTP error — Nitro's default error handler would call
    // `setResponseHeaders` after headers were already sent and crash with
    // ERR_HTTP_HEADERS_SENT (logged as an unhandled error). Client aborts on
    // long downloads are expected (cancelled jobs, parallel runners), so we
    // log and swallow once headers are out.
    if (event.node.res.headersSent) {
      logger.debug(`Client aborted /download/${cacheEntryId}: ${(err as Error).message}`)
      return
    }
    throw err
  }
})
