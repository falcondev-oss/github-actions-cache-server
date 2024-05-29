import { z } from 'zod'

import { auth } from '~/lib/auth'
import { logger } from '~/lib/logger'
import { storageAdapter } from '~/lib/storage'

import type { Buffer } from 'node:buffer'

const pathParamsSchema = z.object({
  cacheId: z.coerce.number(),
})

export default defineEventHandler({
  onRequest: [auth],
  handler: async (event) => {
    const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
    if (!parsedPathParams.success) throw createError({ statusCode: 400 })

    const { cacheId } = parsedPathParams.data

    const stream = getRequestWebStream(event)
    if (!stream) {
      logger.debug('Upload: Request body is not a stream')
      throw createError({ statusCode: 400 })
    }

    const contentRangeHeader = getHeader(event, 'content-range')
    if (!contentRangeHeader) {
      logger.debug("Upload: 'content-range' header not found")
      throw createError({ statusCode: 400 })
    }

    const { start, end } = parseContentRangeHeader(contentRangeHeader)
    if (Number.isNaN(start) || Number.isNaN(end)) {
      logger.debug(`Upload: Invalid 'content-range' header (${contentRangeHeader})`)
      throw createError({ statusCode: 400 })
    }

    await storageAdapter.uploadChunk(cacheId, stream as ReadableStream<Buffer>, start, end)
  },
})

function parseContentRangeHeader(contentRange: string) {
  const [start, end] = contentRange.replace('bytes', '').replace('/*', '').trim().split('-')
  return { start: Number.parseInt(start), end: Number.parseInt(end) }
}
