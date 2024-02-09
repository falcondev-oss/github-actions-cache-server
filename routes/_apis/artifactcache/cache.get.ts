import { z } from 'zod'

import { useStorageDriver } from '../../../plugins/storage'

import type { ArtifactCacheEntry } from '../../../utils/types'

const queryParamSchema = z.object({
  keys: z.string().min(1),
  version: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const parsedQuery = queryParamSchema.safeParse(getQuery(event))
  if (!parsedQuery.success)
    throw createError({
      statusCode: 400,
    })

  const { keys, version } = parsedQuery.data

  const storage = useStorageDriver()

  const storageEntry = await storage.getCacheEntry(keys, version)

  if (!storageEntry) throw createError({ statusCode: 204 })

  return storageEntry satisfies ArtifactCacheEntry
})
