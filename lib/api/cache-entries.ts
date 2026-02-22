import { ORPCError } from '@orpc/client'
import z from 'zod'
import { cacheEntrySchema } from '../db'
import { base } from './base'

export const cacheEntriesRouter = base
  .prefix('/cache-entries')
  .tag('Cache Entries')
  .router({
    get: base
      .route({
        method: 'GET',
        path: '/{id}',
        summary: 'Get cache entry',
        description: 'Retrieve a single cache entry by its id.',
      })
      .input(z.object({ id: z.string() }))
      .output(cacheEntrySchema)
      .errors({
        NOT_FOUND: {
          message: 'Cache entry not found',
        },
      })
      .handler(async ({ input, context }) => {
        const cacheEntry = await context.db
          .selectFrom('cache_entries')
          .where('id', '=', input.id)
          .selectAll()
          .executeTakeFirst()
        if (!cacheEntry) throw new ORPCError('NOT_FOUND')

        return cacheEntry
      }),
    match: base
      .route({
        method: 'GET',
        path: '/match',
        summary: 'Match cache entry',
        description:
          'Find the best matching cache entry using the primary key and optional restore keys across the given scopes. Returns the matched entry along with the match type, or null if no match is found. Basically what the cache server does when deciding which cache entry to restore for a given cache restore request.',
      })
      .input(
        z.object({
          primaryKey: z.string().describe('The primary cache key to match against'),
          restoreKeys: z
            .array(z.string())
            .optional()
            .describe('Optional fallback keys to try if the primary key does not match'),
          scopes: z.array(z.string()).describe('Scopes to search within, checked in order'),
          version: z.string().describe('Cache version identifier'),
        }),
      )
      .output(
        z
          .object({
            match: cacheEntrySchema,
            type: z
              .enum(['exact-primary', 'prefixed-primary', 'exact-restore', 'prefixed-restore'])
              .describe(
                'How the match was found: exact-primary (exact primary key match), prefixed-primary (primary key prefix match), exact-restore (exact restore key match), prefixed-restore (restore key prefix match)',
              ),
          })
          .nullable(),
      )
      .handler(async ({ input, context }) => {
        const cacheEntry = await context.storage.matchCacheEntry({
          keys: [input.primaryKey, ...(input.restoreKeys ?? [])],
          scopes: input.scopes,
          version: input.version,
        })

        return cacheEntry ?? null
      }),
    findMany: base
      .route({
        method: 'GET',
        path: '/',
        summary: 'List cache entries',
        description:
          'Retrieve a paginated list of cache entries, optionally filtered by key, version, and scope.',
      })
      .input(
        z.object({
          key: z.string().optional().describe('Filter by exact cache key'),
          version: z.string().optional().describe('Filter by exact cache version'),
          scope: z.string().optional().describe('Filter by exact cache scope'),
          itemsPerPage: z
            .number()
            .int()
            .positive()
            .min(1)
            .max(100)
            .default(20)
            .describe('Number of items per page'),
          page: z.number().int().positive().min(1).default(1).describe('Page number'),
        }),
      )
      .output(
        z.object({
          total: z.number(),
          items: z.array(cacheEntrySchema),
        }),
      )
      .handler(async ({ input, context }) => {
        const query = context.db.selectFrom('cache_entries')
        if (input.key) query.where('key', '=', input.key)
        if (input.version) query.where('version', '=', input.version)
        if (input.scope) query.where('scope', '=', input.scope)

        const [cacheEntries, countResult] = await Promise.all([
          query
            .selectAll()
            .limit(input.itemsPerPage)
            .offset((input.page - 1) * input.itemsPerPage)
            .execute(),
          query.select((eb) => [eb.fn.countAll<number>().as('count')]).executeTakeFirst(),
        ])

        return {
          total: countResult?.count ?? 0,
          items: cacheEntries,
        }
      }),
    delete: base
      .route({
        method: 'DELETE',
        path: '/{id}',
        summary: 'Delete cache entry',
        description:
          'Delete a single cache entry by its id. Triggers cleanup of orphaned storage locations.',
      })
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .handler(async ({ input, context }) => {
        await context.db.deleteFrom('cache_entries').where('id', '=', input.id).execute()
        context.event.waitUntil(runTask('cleanup:storage-locations'))
      }),
    deleteMany: base
      .route({
        method: 'DELETE',
        path: '/',
        summary: 'Delete cache entries',
        description:
          'Delete multiple cache entries matching the given filters. Triggers cleanup of orphaned storage locations.',
      })
      .input(
        z.object({
          key: z.string().optional().describe('Filter by exact cache key'),
          version: z.string().optional().describe('Filter by exact cache version'),
          scope: z.string().optional().describe('Filter by exact cache scope'),
        }),
      )
      .handler(async ({ input, context }) => {
        const query = context.db.deleteFrom('cache_entries')
        if (input.key) query.where('key', '=', input.key)
        if (input.version) query.where('version', '=', input.version)
        if (input.scope) query.where('scope', '=', input.scope)

        await query.execute()
        context.event.waitUntil(runTask('cleanup:storage-locations'))
      }),
  })
