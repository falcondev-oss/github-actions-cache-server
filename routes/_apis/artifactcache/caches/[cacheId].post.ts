import { z } from 'zod'

import { useStorageDriver } from '../../../../plugins/storage'

const pathParamsSchema = z.object({
  cacheId: z.coerce.number(),
})

const bodySchema = z.object({
  size: z.number().positive(),
})

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success) throw createError({ statusCode: 400 })

  const { cacheId } = parsedPathParams.data

  const body = (await readBody(event)) as unknown
  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success) throw createError({ statusCode: 400 })

  const { size } = parsedBody.data

  const storage = useStorageDriver()

  await storage.commitCache(cacheId, size)
})
