import { createHash } from 'node:crypto'

import { z } from 'zod'

import { useStorageDriver } from '../../../plugins/storage'

const pathParamsSchema = z.object({
  cacheId: z.coerce.number(),
  hash: z.string(),
})

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success) throw createError({ statusCode: 400 })

  const { cacheId, hash } = parsedPathParams.data

  const hashedCacheId = createHash('sha256')
    .update(cacheId.toString() + ENV.SECRET)
    .digest('base64url')
  if (hashedCacheId !== hash) throw createError({ statusCode: 403 })

  const storage = useStorageDriver()
  const stream = await storage.download(cacheId)

  return sendStream(event, stream)
})
