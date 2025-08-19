import type { Buffer } from 'node:buffer'

import cluster from 'node:cluster'

import { randomBytes, randomInt } from 'node:crypto'
import { createSingletonPromise } from '@antfu/utils'
import consola from 'consola'
import {
  findKeyMatch,
  findStaleKeys,
  getUpload,
  pruneKeys,
  touchKey,
  updateOrCreateKey,
  useDB,
} from '~/lib/db'
import { ENV } from '~/lib/env'

import { logger } from '~/lib/logger'
import { getStorageDriver } from '~/lib/storage/drivers'
import { getObjectNameFromKey } from '~/lib/utils'

export const useStorageAdapter = createSingletonPromise(async () => {
  try {
    const driverName = ENV.STORAGE_DRIVER
    const driverClass = getStorageDriver(driverName)
    if (!driverClass) {
      consola.error(`No storage driver found for ${driverName}`)
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(1)
    }
    if (cluster.isPrimary) logger.info(`Using storage driver: ${driverName}`)

    const driver = await driverClass.create()
    const db = await useDB()

    return {
      async reserveCache({ key, version }: { key: string; version: string }) {
        logger.debug('Reserve:', { key, version })

        if (await getUpload(db, { key, version })) {
          logger.debug(`Reserve: Already reserved. Ignoring...`, { key, version })
          return {
            cacheId: null,
          }
        }

        const uploadId = randomInt(1_000_000_000, 9_999_999_999)

        await db
          .insertInto('uploads')
          .values({
            created_at: new Date().toISOString(),
            id: uploadId.toString(),
            key,
            version,
          })
          .execute()

        logger.debug(`Reserve:`, {
          key,
          version,
          uploadId,
        })

        return {
          cacheId: uploadId,
        }
      },
      async uploadChunk({
        uploadId,
        chunkStream,
        chunkStart,
        chunkIndex,
      }: {
        uploadId: number
        chunkStream: ReadableStream<Buffer>
        chunkStart: number
        chunkIndex: number
      }) {
        const upload = await db
          .selectFrom('uploads')
          .selectAll()
          .where('id', '=', uploadId.toString())
          .executeTakeFirst()
        if (!upload) {
          logger.debug(`Upload: Upload not found. Ignoring...`, {
            uploadId,
          })
          return
        }

        const partNumber = chunkIndex + 1

        try {
          await driver.uploadPart({
            uploadId: upload.id,
            partNumber,
            data: chunkStream,
          })
          await db
            .insertInto('upload_parts')
            .values({
              part_number: partNumber,
              upload_id: uploadId.toString(),
            })
            .execute()
        } catch (err) {
          logger.debug(
            'Upload: Error',
            {
              uploadId,
              chunkStart,
              partNumber,
            },
            err,
          )
          throw err
        }

        logger.debug('Upload:', { uploadId, chunkStart, partNumber })
      },
      async commitCache(uploadId: number | string) {
        const upload = await db
          .selectFrom('uploads')
          .selectAll()
          .where('id', '=', uploadId.toString())
          .executeTakeFirst()

        if (!upload) {
          logger.debug('Commit: Upload not found. Ignoring...')
          return
        }

        const parts = await db
          .selectFrom('upload_parts')
          .selectAll()
          .where('upload_id', '=', upload.id)
          .orderBy('part_number', 'asc')
          .execute()

        await db.transaction().execute(async (tx) => {
          logger.debug('Commit:', uploadId)

          await tx.deleteFrom('uploads').where('id', '=', upload.id).execute()
          await updateOrCreateKey(tx, {
            key: upload.key,
            version: upload.version,
          })

          await driver.completeMultipartUpload({
            finalOutputObjectName: getObjectNameFromKey(upload.key, upload.version),
            uploadId: upload.id,
            partNumbers: parts.map((part) => part.part_number),
          })
        })
      },
      async getCacheEntry({ keys, version }: { keys: string[]; version: string }) {
        const primaryKey = keys[0]
        const restoreKeys = keys.length > 1 ? keys.slice(1) : undefined

        const cacheKey = await findKeyMatch(db, { key: primaryKey, version, restoreKeys })

        if (!cacheKey) {
          logger.debug('Get: Cache entry not found', { keys, version })
          return null
        }

        await touchKey(db, { key: cacheKey.key, version: cacheKey.version })

        const objectName = getObjectNameFromKey(cacheKey.key, cacheKey.version)

        logger.debug('Get: Found', cacheKey)

        return {
          archiveLocation:
            ENV.ENABLE_DIRECT_DOWNLOADS && driver.createDownloadUrl
              ? await driver.createDownloadUrl(objectName)
              : createLocalDownloadUrl(objectName),
          cacheKey: cacheKey.key,
        }
      },
      async download(objectName: string) {
        logger.debug('Download:', objectName)
        return driver.createReadStream(objectName)
      },
      async pruneCaches(olderThanDays?: number) {
        logger.debug('Prune:', {
          olderThanDays,
        })

        const keys = await findStaleKeys(db, { olderThanDays })
        if (keys.length === 0) {
          logger.debug('Prune: No caches to prune')
          return
        }

        await driver.delete(keys.map((key) => getObjectNameFromKey(key.key, key.version)))
        await pruneKeys(db, keys)

        logger.debug('Prune: Caches pruned', {
          olderThanDays,
        })
      },
      async pruneUploads(olderThanDate: Date) {
        logger.debug('Prune uploads')

        // uploads older than 24 hours
        const uploads = await db
          .selectFrom('uploads')
          .selectAll()
          .where('created_at', '<', olderThanDate.toISOString())
          .execute()

        for (const upload of uploads) {
          try {
            await driver.cleanupMultipartUpload(upload.id)
            await db.deleteFrom('uploads').where('id', '=', upload.id).execute()
          } catch (err) {
            logger.error('Failed to cleanup upload', upload, err)
          }
        }
      },
    }
  } catch (err) {
    consola.error('Failed to initialize storage driver:', err)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
})

function createLocalDownloadUrl(objectName: string) {
  return `${ENV.API_BASE_URL}/download/${randomBytes(64).toString('hex')}/${objectName}`
}
