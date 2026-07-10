import { getDatabase } from '~/lib/db'
import { env } from '~/lib/env'
import { getStorage } from '~/lib/storage'
import { CleanupAggregateError, runCleanupTask } from '~/lib/storage-lifecycle'

const itemsPerPage = 10

export default defineTask({
  meta: {
    name: 'cleanup:uploads',
    description: 'Delete uploads without activity for over 1 minute',
  },
  async run() {
    const result = {
      skipped: !!env.DISABLE_CLEANUP_JOBS,
      deletedUploads: 0,
      deletedObjects: 0,
      deletedBytes: 0,
      failures: 0,
      durationMs: 0,
    }
    return runCleanupTask({
      task: 'cleanup:uploads',
      result,
      async run() {
        if (result.skipped) return
        const oneMinuteAgo = Date.now() - 60 * 1000
        const [db, storage] = await Promise.all([getDatabase(), getStorage()])
        const errors: unknown[] = []
        while (true) {
          const uploads = await db
            .selectFrom('uploads')
            .where(({ eb, or, and }) =>
              and([
                or([
                  eb('lastPartUploadedAt', 'is', null),
                  eb('lastPartUploadedAt', '<', oneMinuteAgo),
                ]),
                eb('createdAt', '<', oneMinuteAgo),
              ]),
            )
            .select(['id', 'folderName'])
            .limit(itemsPerPage)
            .execute()
          if (uploads.length === 0) break

          for (const upload of uploads) {
            await db.deleteFrom('uploads').where('id', '=', upload.id).execute()
            result.deletedUploads++
            try {
              const reclaimed = await storage.adapter.deleteFolder(upload.folderName)
              result.deletedObjects += reclaimed.objects
              result.deletedBytes += reclaimed.bytes
            } catch (err) {
              result.failures++
              errors.push(err)
            }
          }
          if (uploads.length < itemsPerPage) break
        }

        if (errors.length > 0) {
          throw new CleanupAggregateError(
            errors,
            'Failed to delete abandoned upload storage',
            result,
          )
        }
      },
    })
  },
})
