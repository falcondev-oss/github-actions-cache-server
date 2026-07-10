import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { getStorage } from '~/lib/storage'
import {
  CleanupAggregateError,
  reconcileOrphanedStorage,
  runCleanupTask,
} from '~/lib/storage-lifecycle'

export default defineTask({
  meta: {
    name: 'cleanup:orphaned-storage',
    description: 'Delete grace-expired storage folders not authorized by database records',
  },
  async run() {
    const result = {
      skipped: !!env.DISABLE_CLEANUP_JOBS,
      inspectedFolders: 0,
      authorizedFolders: 0,
      gracePeriodFolders: 0,
      deletedFolders: 0,
      deletedObjects: 0,
      deletedBytes: 0,
      failures: 0,
      durationMs: 0,
    }
    return runCleanupTask({
      task: 'cleanup:orphaned-storage',
      result,
      async run() {
        if (result.skipped) return
        const [db, storage] = await Promise.all([getDatabase(), getStorage()])
        try {
          Object.assign(
            result,
            await reconcileOrphanedStorage({
              db,
              adapter: storage.adapter,
              gracePeriodHours: env.ORPHANED_STORAGE_GRACE_PERIOD_HOURS,
            }),
          )
        } catch (err) {
          if (err instanceof CleanupAggregateError) Object.assign(result, err.summary)
          throw err
        }
      },
    })
  },
})
