import { z } from 'zod'

import { auth } from '~/lib/auth'
import { storageAdapter } from '~/lib/storage'
import type { ReserveCacheResponse } from '~/lib/types'

const bodySchema = z.object({
  key: z.string().min(1),
  version: z.string(),
  cacheSize: z.number().positive().nullish(),
})

export default defineEventHandler({
  onRequest: [auth],
  handler: async (event) => {
    const body = (await readBody(event)) as unknown
    const parsedBody = bodySchema.safeParse(body)
    if (!parsedBody.success)
      throw createError({
        statusCode: 400,
        statusMessage: `Invalid body: ${parsedBody.error.message}`,
      })

    const { cacheSize, key, version } = parsedBody.data

    const response = await storageAdapter.reserveCache(key, version, cacheSize ?? undefined)

    return response satisfies ReserveCacheResponse
  },
})
