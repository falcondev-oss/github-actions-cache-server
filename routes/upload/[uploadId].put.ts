import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'
import { logger } from '~/lib/logger'

import { getStorage } from '~/lib/storage'

const pathParamsSchema = z.object({
  uploadId: z.string(),
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
    // prevent random EOF error with in tonistiigi/go-actions-cache caused by missing request id
    setHeader(event, 'x-ms-request-id', randomUUID())
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

  const { uploadId } = parsedPathParams.data

  const stream = getRequestWebStream(event)
  if (!stream) {
    logger.debug('Upload: Request body is not a stream')
    throw createError({ statusCode: 400, statusMessage: 'Request body must be a stream' })
  }

  const storage = await getStorage()
  await storage.uploadPart(uploadId.toString(), chunkIndex, stream)

  // prevent random EOF error with in tonistiigi/go-actions-cache caused by missing request id
  setHeader(event, 'x-ms-request-id', randomUUID())
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
