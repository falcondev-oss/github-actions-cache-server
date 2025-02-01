import { z } from 'zod'

import { useStorageAdapter } from '~/lib/storage'

const queryParamSchema = z.object({
  keys: z
    .string()
    .min(1)
    .transform((value) => value.split(',')),
  version: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const parsedQuery = queryParamSchema.safeParse(getQuery(event))
  if (!parsedQuery.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid query parameters: ${parsedQuery.error.message}`,
    })

  const { keys, version } = parsedQuery.data

  const adapter = await useStorageAdapter()
  const storageEntry = await adapter.getCacheEntry(keys, version)

  if (!storageEntry) {
    setResponseStatus(event, 204)
    return
  }

  return storageEntry
})
