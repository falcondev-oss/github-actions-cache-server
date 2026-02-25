import { z } from 'zod'
import { env } from '~/lib/env'
import { getCacheScopes } from '~/lib/scope'
import { getStorage } from '~/lib/storage'

const bodySchema = z.object({
  key: z.string(),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const scopes = await getCacheScopes(event)

  const body = (await readBody(event)) as unknown
  const parsedBody = bodySchema.safeParse(body)
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

  const upload = await storage.createUpload(key, version, writeScope.Scope)
  if (!upload)
    return {
      ok: false,
    }

  return {
    ok: true,
    signed_upload_url: `${env.API_BASE_URL}/upload/${upload.id}`,
  }
})
