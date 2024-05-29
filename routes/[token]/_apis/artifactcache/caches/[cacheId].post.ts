import { z } from 'zod'

import { auth } from '~/lib/auth'
import { storageAdapter } from '~/lib/storage'

const pathParamsSchema = z.object({
  cacheId: z.coerce.number(),
})

const bodySchema = z.object({
  size: z.number().positive(),
})

export default defineEventHandler({
  onRequest: [auth],
  handler: async (event) => {
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

    await storageAdapter.commitCache(cacheId, size)
  },
})
