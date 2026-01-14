import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'

export default defineTask({
  meta: {
    name: 'cleanup:merges',
    description: 'Reset stalled merges that have not completed within 15 minutes',
  },
  async run() {
    if (env.DISABLE_CLEANUP_JOBS) return {}

    const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000
    const db = await getDatabase()

    const res = await db
      .updateTable('storage_locations')
      .where('mergeStartedAt', '<', fifteenMinutesAgo)
      .where('mergedAt', 'is', null)
      .set({
        mergeStartedAt: null,
        mergedAt: null,
      })
      .executeTakeFirst()

    return {
      result: {
        updated: res.numUpdatedRows,
      },
    }
  },
})
