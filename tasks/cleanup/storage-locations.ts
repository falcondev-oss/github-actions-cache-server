import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { getStorage } from '~/lib/storage'
import {
  CleanupAggregateError,
  deleteStorageLocationIfUnread,
  noActiveReaderLease,
  runCleanupTask,
} from '~/lib/storage-lifecycle'

const itemsPerPage = 10

export default defineTask({
  meta: {
    name: 'cleanup:storage-locations',
    description: 'Delete storage locations not associated with any cache entries',
  },
  async run() {
    const result = {
      skipped: !!env.DISABLE_CLEANUP_JOBS,
      deletedLocations: 0,
      deletedObjects: 0,
      deletedBytes: 0,
      failures: 0,
      durationMs: 0,
    }
    return runCleanupTask({
      task: 'cleanup:storage-locations',
      result,
      async run() {
        if (result.skipped) return
        const [db, storage] = await Promise.all([getDatabase(), getStorage()])
        const errors: unknown[] = []
        while (true) {
          const locations = await db
            .selectFrom('storage_locations')
            .select(['folderName', 'id'])
            .where(({ exists, not }) =>
              not(
                exists((eb) =>
                  eb
                    .selectFrom('cache_entries')
                    .select('id')
                    .whereRef('cache_entries.locationId', '=', 'storage_locations.id'),
                ),
              ),
            )
            .where((eb) => noActiveReaderLease(eb))
            .limit(itemsPerPage)
            .execute()
          if (locations.length === 0) break

          for (const location of locations) {
            const deleted = await db.transaction().execute(async (tx) => {
              return deleteStorageLocationIfUnread(tx, location.id)
            })
            if (!deleted) continue
            result.deletedLocations++
            try {
              const reclaimed = await storage.adapter.deleteFolder(location.folderName)
              result.deletedObjects += reclaimed.objects
              result.deletedBytes += reclaimed.bytes
            } catch (err) {
              result.failures++
              errors.push(err)
            }
          }
          if (locations.length < itemsPerPage) break
        }

        if (errors.length > 0) {
          throw new CleanupAggregateError(errors, 'Failed to delete unreferenced storage', result)
        }
      },
    })
  },
})
