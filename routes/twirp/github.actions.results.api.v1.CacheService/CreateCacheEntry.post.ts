import { z } from 'zod'
import { env } from '~/lib/env'
import { getStorage } from '~/lib/storage'

const bodySchema = z.object({
  key: z.string(),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as unknown
  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsedBody.error.message}`,
    })

  const { key, version } = parsedBody.data

  const storage = await getStorage()
  const upload = await storage.createUpload(key, version)
  if (!upload)
    return {
      ok: false,
    }

  return {
    ok: true,
    signed_upload_url: `${env.API_BASE_URL}/upload/${upload.id}`,
  }
})
