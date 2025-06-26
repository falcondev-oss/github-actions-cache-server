import { z } from 'zod'
import { useStorageAdapter } from '~/lib/storage'

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
  const adapter = await useStorageAdapter()
  const storageEntry = await adapter.getCacheEntry({
    keys: [key, ...(restore_keys ?? [])],
    version,
  })

  if (!storageEntry)
    return {
      ok: false,
    }

  return {
    ok: true,
    signed_download_url: storageEntry.archiveLocation,
    matched_key: storageEntry.cacheKey,
  }
})
