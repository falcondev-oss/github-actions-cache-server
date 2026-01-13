import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { getStorage } from '~/lib/storage'

const itemsPerPage = 10

export default defineTask({
  meta: {
    name: 'cleanup:storage-locations',
    description: 'Delete storage locations not associated with any cache entries',
  },
  async run() {
    if (env.DISABLE_CLEANUP_JOBS) return {}

    const db = await getDatabase()
    const storage = await getStorage()

    let deletedCount = 0
    let page = 0
    while (true) {
      const storageLocations = await db
        .selectFrom('storage_locations')
        .select(['folderName', 'id'])
        .where(({ exists, not }) =>
          not(
            exists((eb) =>
              eb
                .selectFrom('cache_entries')
                .where('cache_entries.locationId', '=', eb.ref('storage_locations.id')),
            ),
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
