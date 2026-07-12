import { z } from 'zod'
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
    TwirpMessage.FinalizeCacheEntryUploadRequest,
  )

  const storage = await getStorage()
  const writeScope = scopes.find((s) => s.Permission >= 2)
  if (!writeScope)
    throw createError({ statusCode: 403, message: 'No scope with write permission found' })

  const upload = await storage.completeUpload({ key, version, scope: writeScope.Scope, repoId })
  if (!upload)
    throw createError({
      statusCode: 404,
      statusMessage: 'Upload not found',
    })

  return sendTwirpResponse(
    event,
    { ok: true, entry_id: upload.id.toString() },
    TwirpMessage.FinalizeCacheEntryUploadResponse,
  )
})
