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
    name: 'cleanup:cache-entries',
    description: 'Delete cache entries older than the configured retention period',
  },
  async run() {
    const result = {
      skipped: !!env.DISABLE_CLEANUP_JOBS || env.CACHE_CLEANUP_OLDER_THAN_DAYS === 0,
      deletedLocations: 0,
      deletedObjects: 0,
      deletedBytes: 0,
      failures: 0,
      durationMs: 0,
    }
    return runCleanupTask({
      task: 'cleanup:cache-entries',
      result,
      async run() {
        if (result.skipped) return
        const cutoff = Date.now() - env.CACHE_CLEANUP_OLDER_THAN_DAYS * 24 * 60 * 60 * 1000
        const [db, storage] = await Promise.all([getDatabase(), getStorage()])
        const errors: unknown[] = []

        while (true) {
          const locations = await db
            .selectFrom('storage_locations')
            .innerJoin('cache_entries', 'cache_entries.locationId', 'storage_locations.id')
            .select(['storage_locations.folderName', 'storage_locations.id'])
            .where(({ and, eb, or }) =>
              or([
                and([
                  eb('storage_locations.lastDownloadedAt', 'is', null),
                  eb('cache_entries.updatedAt', '<', cutoff),
                ]),
                and([
                  eb('storage_locations.lastDownloadedAt', 'is not', null),
                  eb('storage_locations.lastDownloadedAt', '<', cutoff),
                  eb('cache_entries.updatedAt', '<', cutoff),
                ]),
              ]),
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
          throw new CleanupAggregateError(errors, 'Failed to delete retained cache storage', result)
        }
      },
    })
  },
})
