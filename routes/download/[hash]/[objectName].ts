import { createHash } from 'node:crypto'

import { z } from 'zod'

import { DOWNLOAD_SECRET_KEY, useStorageAdapter } from '~/lib/storage'

const pathParamsSchema = z.object({
  objectName: z.string(),
  hash: z.string(),
})

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid path parameters: ${parsedPathParams.error.message}`,
    })

  const { objectName, hash } = parsedPathParams.data

  const hashedCacheId = createHash('sha256')
    .update(objectName + DOWNLOAD_SECRET_KEY)
    .digest('base64url')
  if (hashedCacheId !== hash) throw createError({ statusCode: 403, statusMessage: 'Forbidden' })

  const stream = await useStorageAdapter().download(objectName)

  return sendStream(event, stream)
})
