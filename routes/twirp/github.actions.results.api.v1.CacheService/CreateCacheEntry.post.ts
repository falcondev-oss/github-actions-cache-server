import { z } from 'zod'
import { env } from '~/lib/env'
import { getCacheScope } from '~/lib/scope'
import { AlreadyExistsError, getStorage } from '~/lib/storage'
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

  let upload
  try {
    upload = await storage.createUpload({ key, version, scope: writeScope.Scope, repoId })
  } catch (err) {
    if (!(err instanceof AlreadyExistsError)) throw err

    // GitHub answers a duplicate reservation with 409 already_exists, not 200 with ok: false
    setResponseStatus(event, 409)
    return {
      code: 'already_exists',
      msg: 'cache entry with the same key, version, and scope already exists',
    }
  }

  return sendTwirpResponse(
    event,
    { ok: true, signed_upload_url: `${env.API_BASE_URL}/devstoreaccount1/upload/${upload.id}` },
    TwirpMessage.CreateCacheEntryResponse,
  )
})
