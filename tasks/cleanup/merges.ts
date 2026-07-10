import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { runCleanupTask } from '~/lib/storage-lifecycle'

export default defineTask({
  meta: {
    name: 'cleanup:merges',
    description: 'Reset stalled merges that have not completed within 15 minutes',
  },
  async run() {
    const result = {
      skipped: !!env.DISABLE_CLEANUP_JOBS,
      updated: 0,
      failures: 0,
      durationMs: 0,
    }
    return runCleanupTask({
      task: 'cleanup:merges',
      result,
      async run() {
        if (result.skipped) return
        const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000
        const db = await getDatabase()
        const res = await db
          .updateTable('storage_locations')
          .where('mergeStartedAt', '<', fifteenMinutesAgo)
          .where('mergedAt', 'is', null)
          .where(({ exists, not }) =>
            not(
              exists((eb) =>
                eb
                  .selectFrom('merge_leases')
                  .select('storageLocationId')
                  .whereRef('merge_leases.storageLocationId', '=', 'storage_locations.id')
                  .where('expiresAt', '>', Date.now()),
              ),
            ),
          )
          .set({ mergeStartedAt: null, mergedAt: null })
          .executeTakeFirst()

        await db.deleteFrom('merge_leases').where('expiresAt', '<=', Date.now()).execute()
        result.updated = Number(res.numUpdatedRows)
      },
    })
  },
})
