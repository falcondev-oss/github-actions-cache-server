import { z } from 'zod'

import { useStorageAdapter } from '~/lib/storage'

const bodySchema = z.object({
  key: z.string().min(1),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as unknown
  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsedBody.error.message}`,
    })

  const { key, version } = parsedBody.data

  const adapter = await useStorageAdapter()
  return adapter.reserveCache({ key, version })
})
