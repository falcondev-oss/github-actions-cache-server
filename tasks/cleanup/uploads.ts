import { getDatabase } from '~/lib/db'
import { ENV } from '~/lib/env'
import { getStorage } from '~/lib/storage'

const itemsPerPage = 10

export default defineTask({
  meta: {
    name: 'cleanup:uploads',
    description:
      'Delete uploads without activity for over 1 minute. Since parts are only a few megabytes each, we can be fairly aggressive in cleaning up abandoned uploads.',
  },
  async run() {
    if (ENV.DISABLE_CLEANUP_JOBS) return {}

    const oneMinuteAgo = Date.now() - 60 * 1000
    const db = await getDatabase()
    const storage = await getStorage()

    let deletedCount = 0
    let page = 0
    while (true) {
      const uploads = await db
        .selectFrom('uploads')
        .where(({ eb, or, and }) =>
          and([
            or([eb('lastPartUploadedAt', 'is', null), eb('lastPartUploadedAt', '<', oneMinuteAgo)]), // no parts uploaded or last part uploaded over 1 minute ago
            eb('createdAt', '<', oneMinuteAgo), // older than 1 minute
          ]),
        )
        .selectAll()
        .limit(itemsPerPage)
        .offset(page * itemsPerPage)
        .execute()

      deletedCount += uploads.length

      for (const upload of uploads) {
        await db.transaction().execute(async (tx) => {
          await tx.deleteFrom('uploads').where('id', '=', upload.id).execute()
          await storage.deleteFolder(upload.folderName)
        })
      }

      if (uploads.length < itemsPerPage) break
      page++
    }

    return {
      result: {
        deleted: deletedCount,
      },
    }
  },
})
