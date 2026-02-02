import { z } from 'zod'
import { getMetrics } from '~/lib/metrics'
import { getStorage } from '~/lib/storage'

const bodySchema = z.object({
  key: z.string(),
  restore_keys: z.array(z.string()).nullish().optional(),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const parsedBody = bodySchema.safeParse(await readBody(event))
  if (!parsedBody.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsedBody.error.message}`,
    })

  const { key, restore_keys, version } = parsedBody.data

  const storage = await getStorage()
  const metrics = await getMetrics()

  const match = await storage.getCacheEntryWithDownloadUrl({
    keys: [key, ...(restore_keys ?? [])],
    version,
  })

  if (!match) {
    metrics?.cacheOperationsTotal.add(1, { operation: 'lookup', result: 'miss' })
    return {
      ok: false,
    }
  }

  metrics?.cacheOperationsTotal.add(1, { operation: 'lookup', result: 'hit' })

  return {
    ok: true,
    signed_download_url: match.downloadUrl,
    matched_key: match.cacheEntry.key,
  }
})
