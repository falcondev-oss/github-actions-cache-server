import { map, pipe, prop, sortBy } from 'remeda'
import { z } from 'zod'
import { getCacheScopes } from '~/lib/scope'
import { getStorage } from '~/lib/storage'

const bodySchema = z.object({
  key: z.string(),
  restore_keys: z.array(z.string()).nullish().optional(),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const scopes = await getCacheScopes(event)

  const parsedBody = bodySchema.safeParse(await readBody(event))
  if (!parsedBody.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsedBody.error.message}`,
    })

  const { key, restore_keys, version } = parsedBody.data

  const storage = await getStorage()
  const match = await storage.getCacheEntryWithDownloadUrl({
    keys: [key, ...(restore_keys ?? [])],
    version,
    scopes: pipe(scopes, sortBy([prop('Permission'), 'desc']), map(prop('Scope'))),
  })
  if (!match)
    return {
      ok: false,
    }

  return {
    ok: true,
    signed_download_url: match.downloadUrl,
    matched_key: match.cacheEntry.key,
  }
})
