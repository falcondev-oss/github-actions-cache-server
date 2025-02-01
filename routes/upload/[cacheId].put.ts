import { Buffer } from 'node:buffer'

import { z } from 'zod'
import { logger } from '~/lib/logger'

import { useStorageAdapter } from '~/lib/storage'

// https://github.com/actions/toolkit/blob/340a6b15b5879eefe1412ee6c8606978b091d3e8/packages/cache/src/cache.ts#L470
const chunkSize = 64 * 1024 * 1024

const pathParamsSchema = z.object({
  cacheId: z.coerce.number(),
})

const sizeByBlockId = new Map<string, number>()

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid path parameters: ${parsedPathParams.error.message}`,
    })

  if (getQuery(event).comp === 'blocklist') {
    setResponseStatus(event, 201)
    return 'ok'
  }

  const blockId = getQuery(event)?.blockid as string
  // if no block id, upload smaller than chunk size
  const chunkIndex = blockId ? getChunkIndexFromBlockId(blockId) : 0
  if (chunkIndex === undefined)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid block id: ${blockId}`,
    })

  const { cacheId } = parsedPathParams.data

  const stream = getRequestWebStream(event)
  if (!stream) {
    logger.debug('Upload: Request body is not a stream')
    throw createError({ statusCode: 400, statusMessage: 'Request body must be a stream' })
  }

  const contentLengthHeader = getHeader(event, 'content-length')
  const contentLength = Number.parseInt(contentLengthHeader ?? '')
  if (!contentLengthHeader || Number.isNaN(contentLength)) {
    logger.debug("Upload: 'content-length' header not found")
    throw createError({ statusCode: 400, statusMessage: "'content-length' header is required" })
  }

  sizeByBlockId.set(blockId, contentLength)
  const start = chunkIndex * chunkSize
  const end = start + contentLength - 1

  const adapter = await useStorageAdapter()
  await adapter.uploadChunk(cacheId, stream as ReadableStream<Buffer>, start, end)

  setResponseStatus(event, 201)
})

/**
 * Format (base64 decoded): 06a9ffa8-2e62-4e96-8e5b-15f24c117f1f000000000006
 */
function getChunkIndexFromBlockId(blockId: string) {
  const decoded = Buffer.from(blockId, 'base64').toString('utf8')
  if (decoded.length !== 48) return

  // slice off uuid and convert to number
  const index = Number.parseInt(decoded.slice(36))
  if (Number.isNaN(index)) return

  return index
}
