import { map, pipe, prop, sortBy } from 'remeda'
import { z } from 'zod'
import { cacheRequestsTotal } from '~/lib/metrics'
import { getCacheScope } from '~/lib/scope'
import { getStorage } from '~/lib/storage'
import { readTwirpRequest, sendTwirpResponse, TwirpMessage } from '~/lib/twirp'

const bodySchema = z.object({
  key: z.string().min(1),
  restore_keys: z.array(z.string()).nullish().optional(),
  version: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const { scopes, repoId } = await getCacheScope(event)

  const { key, restore_keys, version } = await readTwirpRequest(
    event,
    bodySchema,
    TwirpMessage.GetCacheEntryDownloadURLRequest,
  )

  const storage = await getStorage()
  const match = await storage.getCacheEntryWithDownloadUrl({
    keys: [key, ...(restore_keys ?? [])],
    version,
    scopes: pipe(scopes, sortBy([prop('Permission'), 'desc']), map(prop('Scope'))),
    repoId,
  })

  cacheRequestsTotal.inc({ result: match ? 'hit' : 'miss' })

  return sendTwirpResponse(
    event,
    match
      ? { ok: true, signed_download_url: match.downloadUrl, matched_key: match.cacheEntry.key }
      : { ok: false },
    TwirpMessage.GetCacheEntryDownloadURLResponse,
  )
})
