import { z } from 'zod'

import type { ReserveCacheResponse } from '@/utils/types'

import { useStorageDriver } from '@/plugins/storage'
import { auth } from '@/utils/auth'

const bodySchema = z.object({
  key: z.string().min(1),
  version: z.string().optional(),
  cacheSize: z.number().positive(),
})

export default defineEventHandler({
  onRequest: [auth],
  handler: async (event) => {
    const body = (await readBody(event)) as unknown
    const parsedBody = bodySchema.safeParse(body)
    if (!parsedBody.success)
      throw createError({
        statusCode: 400,
      })

    const { cacheSize, key, version } = parsedBody.data

    const storage = useStorageDriver()

    const response = await storage.reserveCache(key, cacheSize, version)

    return response satisfies ReserveCacheResponse
  },
})
