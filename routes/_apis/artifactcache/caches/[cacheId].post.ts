import { z } from 'zod'

import { useStorageAdapter } from '~/lib/storage'

const pathParamsSchema = z.object({
  cacheId: z.coerce.number(),
})

const bodySchema = z.object({
  size: z.number().positive(),
})

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid path parameters: ${parsedPathParams.error.message}`,
    })

  const { cacheId } = parsedPathParams.data

  const body = (await readBody(event)) as unknown
  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsedBody.error.message}`,
    })

  const { size } = parsedBody.data

  const adapter = await useStorageAdapter()
  await adapter.commitCache(cacheId, size)
})
