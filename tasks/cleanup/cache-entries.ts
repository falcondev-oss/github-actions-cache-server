import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { getStorage } from '~/lib/storage'

const itemsPerPage = 10

export default defineTask({
  meta: {
    name: 'cleanup:cache-entries',
    description: 'Delete cache entries not downloaded in the last 30 days',
  },
  async run() {
    if (env.DISABLE_CLEANUP_JOBS) return {}

    const xDaysAgo = Date.now() - env.CACHE_CLEANUP_OLDER_THAN_DAYS * 24 * 60 * 60 * 1000
    const db = await getDatabase()
    const storage = await getStorage()

    let deletedCount = 0
    let page = 0
    while (true) {
      const storageLocations = await db
        .selectFrom('storage_locations')
        .innerJoin('cache_entries', 'cache_entries.locationId', 'storage_locations.id')
        .select(['storage_locations.folderName', 'storage_locations.id'])
        .where((eb) =>
          eb(
            eb.fn.coalesce('storage_locations.lastDownloadedAt', 'cache_entries.updatedAt'),
            '<',
            xDaysAgo,
          ),
        )
        .limit(itemsPerPage)
        .offset(page * itemsPerPage)
        .execute()

      deletedCount += storageLocations.length

      for (const location of storageLocations) {
        await db.transaction().execute(async (tx) => {
          await tx.deleteFrom('storage_locations').where('id', '=', location.id).execute()
          await storage.adapter.deleteFolder(location.folderName)
        })
      }

      if (storageLocations.length < itemsPerPage) break
      page++
    }

    return {
      result: {
        deleted: deletedCount,
      },
    }
  },
})
