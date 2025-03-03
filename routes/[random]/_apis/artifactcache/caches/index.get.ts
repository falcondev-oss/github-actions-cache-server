import { z } from 'zod'

import { listEntriesByKey, useDB } from '~/lib/db'

const queryParamSchema = z.object({
  key: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const parsedQuery = queryParamSchema.safeParse(getQuery(event))
  if (!parsedQuery.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid query parameters: ${parsedQuery.error.message}`,
    })

  const { key } = parsedQuery.data

  const db = await useDB()
  const entries = await listEntriesByKey(db, key)

  return {
    totalCount: entries.length,
    artifactCaches: entries.map((entry) => ({
      cacheKey: entry.key,
      cacheVersion: entry.version,
    })),
  }
})
