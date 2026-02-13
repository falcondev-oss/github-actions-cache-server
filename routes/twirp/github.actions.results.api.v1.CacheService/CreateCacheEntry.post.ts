import { z } from 'zod'
import { env } from '~/lib/env'
import { getMetrics } from '~/lib/metrics'
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
  const metrics = await getMetrics()

  const upload = await storage.createUpload(key, version)
  if (!upload)
    return {
      ok: false,
    }

  metrics?.cacheOperationsTotal.add(1, { operation: 'create', result: 'success' })

  return {
    ok: true,
    signed_upload_url: `${env.API_BASE_URL}/upload/${upload.id}`,
  }
})
