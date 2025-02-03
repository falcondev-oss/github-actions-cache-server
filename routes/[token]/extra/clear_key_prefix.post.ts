import { z } from 'zod'

import { auth } from '~/lib/auth'
import { useStorageAdapter } from '~/lib/storage'

const bodySchema = z.object({
  keyPrefix: z.string().min(1),
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

    const { keyPrefix } = parsedBody.data

    await useStorageAdapter().pruneCacheByKeyPrefix(keyPrefix)
  },
})
