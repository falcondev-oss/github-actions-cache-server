import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { getStorage } from '~/lib/storage'
import {
  claimPartsDeletionIfUnread,
  CleanupAggregateError,
  noActiveReaderLease,
  runCleanupTask,
} from '~/lib/storage-lifecycle'

const itemsPerPage = 10

export default defineTask({
  meta: {
    name: 'cleanup:parts',
    description: 'Delete parts of merged cache entries',
  },
  async run() {
    const result = {
      skipped: !!env.DISABLE_CLEANUP_JOBS,
      deletedParts: 0,
      deletedBytes: 0,
      failures: 0,
      durationMs: 0,
    }
    return runCleanupTask({
      task: 'cleanup:parts',
      result,
      async run() {
        if (result.skipped) return
        const [db, storage] = await Promise.all([getDatabase(), getStorage()])
        const errors: unknown[] = []
        while (true) {
          const locations = await db
            .selectFrom('storage_locations')
            .where('mergedAt', 'is not', null)
            .where('partsDeletedAt', 'is', null)
            .where((eb) => noActiveReaderLease(eb, 'parts'))
            .select(['folderName', 'id'])
            .limit(itemsPerPage)
            .execute()
          if (locations.length === 0) break

          for (const location of locations) {
            const claimed = await db.transaction().execute(async (tx) => {
              return claimPartsDeletionIfUnread(tx, location.id)
            })
            if (!claimed) continue
            try {
              const reclaimed = await storage.adapter.deleteFolder(`${location.folderName}/parts`)
              result.deletedParts += reclaimed.objects
              result.deletedBytes += reclaimed.bytes
            } catch (err) {
              await db
                .updateTable('storage_locations')
                .set({ partsDeletedAt: null })
                .where('id', '=', location.id)
                .execute()
              result.failures++
              errors.push(err)
            }
          }
          if (locations.length < itemsPerPage) break
        }

        if (errors.length > 0) {
          throw new CleanupAggregateError(errors, 'Failed to delete merged cache parts', result)
        }
      },
    })
  },
})
