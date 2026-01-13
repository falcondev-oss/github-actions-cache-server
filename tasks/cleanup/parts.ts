import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { getStorage } from '~/lib/storage'

const itemsPerPage = 10

export default defineTask({
  meta: {
    name: 'cleanup:parts',
    description: 'Delete parts of merged cache entries',
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
        .where('mergedAt', 'is not', null)
        .where('partsDeletedAt', 'is', null)
        .select(['folderName', 'id', 'partCount'])
        .limit(itemsPerPage)
        .offset(page * itemsPerPage)
        .execute()

      for (const location of storageLocations) {
        await db.transaction().execute(async (tx) => {
          await tx
            .updateTable('storage_locations')
            .set({
              partsDeletedAt: Date.now(),
            })
            .where('id', '=', location.id)
            .execute()
          await storage.adapter.deleteFolder(`${location.folderName}/parts`)
          deletedCount += location.partCount
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
