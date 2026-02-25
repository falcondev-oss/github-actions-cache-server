import { ORPCError } from '@orpc/client'
import z from 'zod'
import { storageLocationSchema } from '../db'
import { base } from './base'

export const storageLocationsRouter = base
  .prefix('/storage-locations')
  .tag('Storage Locations')
  .router({
    get: base
      .route({
        method: 'GET',
        path: '/{id}',
        summary: 'Get storage location',
        description: 'Retrieve a single storage location by its id.',
      })
      .input(z.object({ id: z.string() }))
      .output(storageLocationSchema)
      .errors({
        NOT_FOUND: {
          message: 'Storage location not found',
        },
      })
      .handler(async ({ input, context }) => {
        const storageLocation = await context.db
          .selectFrom('storage_locations')
          .where('id', '=', input.id)
          .selectAll()
          .executeTakeFirst()
        if (!storageLocation) throw new ORPCError('NOT_FOUND')

        return storageLocation
      }),
    delete: base
      .route({
        method: 'DELETE',
        path: '/{id}',
        summary: 'Delete storage location',
        description:
          'Delete a storage location by its id. Removes the associated folder from storage.',
      })
      .input(z.object({ id: z.string() }))
      .handler(async ({ input, context }) => {
        const storageLocation = await context.db
          .selectFrom('storage_locations')
          .where('id', '=', input.id)
          .selectAll()
          .executeTakeFirst()
        if (!storageLocation) return

        await context.db.transaction().execute(async (tx) => {
          await tx.deleteFrom('storage_locations').where('id', '=', input.id).execute()
          await context.storage.adapter.deleteFolder(storageLocation.folderName)
        })
      }),
  })
