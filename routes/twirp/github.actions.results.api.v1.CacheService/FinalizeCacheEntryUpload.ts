import { z } from 'zod'
import { getUpload, useDB } from '~/lib/db'
import { useStorageAdapter } from '~/lib/storage'

const bodySchema = z.object({
  key: z.string(),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const parsedBody = bodySchema.safeParse(await readBody(event))
  if (!parsedBody.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsedBody.error.message}`,
    })

  const { key, version } = parsedBody.data

  const db = await useDB()
  const adapter = await useStorageAdapter()
  const upload = await getUpload(db, { key, version })
  if (!upload)
    throw createError({
      statusCode: 404,
      statusMessage: 'Upload not found',
    })

  await adapter.commitCache(upload.id)

  return {
    ok: true,
    entry_id: upload.id,
  }
})
