import { z } from 'zod'

import { useStorageAdapter } from '~/lib/storage'

const pathParamsSchema = z.object({
  objectName: z.string(),
})

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid path parameters: ${parsedPathParams.error.message}`,
    })

  const { objectName } = parsedPathParams.data

  const adapter = await useStorageAdapter()
  const stream = await adapter.download(objectName)

  return sendStream(event, stream)
})
