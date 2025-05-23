import { Buffer } from 'node:buffer'

import { z } from 'zod'
import { logger } from '~/lib/logger'

import { useStorageAdapter } from '~/lib/storage'

// https://github.com/actions/toolkit/blob/340a6b15b5879eefe1412ee6c8606978b091d3e8/packages/cache/src/cache.ts#L470
const MB = 1024 * 1024

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

  if (getQuery(event).comp === 'blocklist') {
    setResponseStatus(event, 201)
    return
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

  const userAgent = getHeader(event, 'user-agent')

  // 1 MB for docker buildx
  // 64 MB for everything else
  const chunkSize = userAgent && userAgent.startsWith('azsdk-go-azblob') ? MB : 64 * MB
  const start = chunkIndex * chunkSize
  const end = start + contentLength - 1

  const adapter = await useStorageAdapter()
  await adapter.uploadChunk({
    uploadId: cacheId,
    chunkStream: stream as ReadableStream<Buffer>,
    chunkStart: start,
    chunkEnd: end,
    chunkIndex,
  })

  setResponseStatus(event, 201)
})

function getChunkIndexFromBlockId(blockIdBase64: string) {
  const base64Decoded = Buffer.from(blockIdBase64, 'base64')

  // 64 bytes used by docker buildx
  // 48 bytes used by everything else
  if (base64Decoded.length === 64) {
    return base64Decoded.readUInt32BE(16)
  } else if (base64Decoded.length === 48) {
    const decoded = base64Decoded.toString('utf8')

    // slice off uuid and convert to number
    const index = Number.parseInt(decoded.slice(36))
    if (Number.isNaN(index)) return

    return index
  }
}
