import { z } from 'zod'
import { getCacheScopes } from '~/lib/scope'
import { getStorage } from '~/lib/storage'

const bodySchema = z.object({
  key: z.string(),
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

  const { key, version } = parsedBody.data

  const storage = await getStorage()
  const writeScope = scopes.find((s) => s.Permission >= 2)
  if (!writeScope)
    throw createError({ statusCode: 403, message: 'No scope with write permission found' })

  const upload = await storage.completeUpload(key, version, writeScope.Scope)
  if (!upload)
    throw createError({
      statusCode: 404,
      statusMessage: 'Upload not found',
    })

  return {
    ok: true,
    entry_id: upload.id.toString(),
  }
})
