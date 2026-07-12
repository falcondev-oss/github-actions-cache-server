import { z } from 'zod'
import { env } from '~/lib/env'
import { getCacheScope } from '~/lib/scope'
import { getStorage } from '~/lib/storage'
import { readTwirpRequest, sendTwirpResponse, TwirpMessage } from '~/lib/twirp'

const bodySchema = z.object({
  key: z.string().min(1),
  version: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const { scopes, repoId } = await getCacheScope(event)

  const { key, version } = await readTwirpRequest(
    event,
    bodySchema,
    TwirpMessage.CreateCacheEntryRequest,
  )

  const storage = await getStorage()
  const writeScope = scopes.find((s) => s.Permission >= 2)
  if (!writeScope)
    throw createError({ statusCode: 403, message: 'No scope with write permission found' })

  const upload = await storage.createUpload({ key, version, scope: writeScope.Scope, repoId })

  return sendTwirpResponse(
    event,
    upload
      ? { ok: true, signed_upload_url: `${env.API_BASE_URL}/devstoreaccount1/upload/${upload.id}` }
      : { ok: false },
    TwirpMessage.CreateCacheEntryResponse,
  )
})
