import type { Buffer } from 'node:buffer'

import { z } from 'zod'
import { logger } from '~/lib/logger'

import { useStorageAdapter } from '~/lib/storage'

const pathParamsSchema = z.object({
  cacheId: z.coerce.number(),
})

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid path parameters: ${parsedPathParams.error.message}`,
    })

  const { cacheId } = parsedPathParams.data

  const stream = getRequestWebStream(event)
  if (!stream) {
    logger.debug('Upload: Request body is not a stream')
    throw createError({ statusCode: 400, statusMessage: 'Request body must be a stream' })
  }

  const contentRangeHeader = getHeader(event, 'content-range')
  if (!contentRangeHeader) {
    logger.debug("Upload: 'content-range' header not found")
    throw createError({ statusCode: 400, statusMessage: "'content-range' header is required" })
  }

  const { start, end } = parseContentRangeHeader(contentRangeHeader)
  if (Number.isNaN(start) || Number.isNaN(end)) {
    logger.debug(`Upload: Invalid 'content-range' header (${contentRangeHeader})`)
    throw createError({ statusCode: 400, statusMessage: 'Invalid content-range header' })
  }

  const adapter = await useStorageAdapter()
  await adapter.uploadChunk(cacheId, stream as ReadableStream<Buffer>, start, end)
})

function parseContentRangeHeader(contentRange: string) {
  const [start, end] = contentRange.replace('bytes', '').replace('/*', '').trim().split('-')
  return { start: Number.parseInt(start), end: Number.parseInt(end) }
}
