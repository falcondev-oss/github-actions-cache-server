import { z } from 'zod'
import { getDatabase } from '~/lib/db'

const querySchema = z.object({
  key: z.string().optional(),
  version: z.string().optional(),
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export default defineEventHandler(async (event) => {
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success)
    throw createError({ statusCode: 400, statusMessage: parsed.error.message })

  const { key, version, page, limit } = parsed.data
  const db = await getDatabase()

  let query = db
    .selectFrom('cache_entries')
    .selectAll()
    .orderBy('updatedAt', 'desc')
    .limit(limit)
    .offset(page * limit)

  if (key) query = query.where('key', 'like', `${key}%`)
  if (version) query = query.where('version', '=', version)

  const [items, total] = await Promise.all([
    query.execute(),
    db
      .selectFrom('cache_entries')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .$if(!!key, (q) => q.where('key', 'like', `${key}%`))
      .$if(!!version, (q) => q.where('version', '=', version!))
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.count)),
  ])

  return { items, total, page, limit }
})
