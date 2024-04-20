import { z } from 'zod'

import { auth } from '~/lib/auth'
import { storageAdapter } from '~/lib/storage'
import type { ArtifactCacheEntry } from '~/lib/types'

const queryParamSchema = z.object({
  keys: z
    .string()
    .min(1)
    .transform((value) => value.split(',')),
  version: z.string().min(1),
})

export default defineEventHandler({
  onRequest: [auth],
  handler: async (event) => {
    const parsedQuery = queryParamSchema.safeParse(getQuery(event))
    if (!parsedQuery.success)
      throw createError({
        statusCode: 400,
      })

    const { keys, version } = parsedQuery.data

    const storageEntry = await storageAdapter.getCacheEntry(keys, version)

    if (!storageEntry) throw createError({ statusCode: 204 })

    return storageEntry satisfies ArtifactCacheEntry
  },
})
