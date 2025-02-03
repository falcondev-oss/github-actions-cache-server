import { randomBytes, randomInt } from 'node:crypto'

import consola from 'consola'

import {
  findKeyMatch,
  findStaleKeys,
  pruneKeys,
  touchKey,
  updateOrCreateKey,
  uploadExists,
  useDB,
  findPrefixedKeysForRemoval,
} from '~/lib/db'
import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'
import { getStorageDriver } from '~/lib/storage/drivers'
import { getObjectNameFromKey } from '~/lib/utils'

import type { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'

export interface Storage {
  pruneCacheByKeyPrefix: (keyPrefix: string) => Promise<void>
  getCacheEntry: (
    keys: string[],
    version: string,
  ) => Promise<{
    cacheKey?: string
    archiveLocation: string
  } | null>
  download: (objectName: string) => Promise<ReadableStream | Readable>
  uploadChunk: (
    uploadId: number,
    chunkStream: ReadableStream<Buffer>,
    chunkStart: number,
    chunkEnd: number,
  ) => Promise<void>
  commitCache: (uploadId: number, size: number) => Promise<void>
  reserveCache: (
    key: string,
    version: string,
    cacheSize?: number,
  ) => Promise<{
    cacheId: number | null
  }>
  pruneCaches: (olderThanDays?: number) => Promise<void>
  pruneUploads: () => Promise<void>
}

let storage: Storage

export async function initializeStorage() {
  try {
    const driverName = ENV.STORAGE_DRIVER
    const driverSetup = getStorageDriver(driverName)
    if (!driverSetup) {
      consola.error(`No storage driver found for ${driverName}`)
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(1)
    }
    logger.info(`Using storage driver: ${driverName}`)

    const driver = await driverSetup()
    const db = useDB()

    storage = {

      async pruneCacheKeys(keysForRemoval){
        if (keysForRemoval.length === 0) {
          logger.debug('Prune: No caches to prune')
          return
        }

        await driver.delete({
          objectNames: keysForRemoval.map((key) => getObjectNameFromKey(key.key, key.version)),
        })

        await pruneKeys(db, keysForRemoval)
      },

      async pruneStaleCacheByType(key){
        if (!ENV.ENABLE_TYPED_KEY_PREFIX_REMOVAL){
          return
        }
        let keyTypeIndex = key.indexOf(ENV.TYPED_KEY_DELIMITER)
        if (keyTypeIndex < 1){
          return
        }
        let keyType = key.substring(0, keyTypeIndex)
        logger.debug(`Prune by type is called: Type [${keyType}]. Full key [${key}].`)
        let keysForRemoval = await findPrefixedKeysForRemoval(db, { keyPrefix: keyType, skipRecentKeysLimit: ENV.MAX_STORED_KEYS_PER_TYPE } )
        logger.debug(`Removing ${keysForRemoval.length} keys for prefix [${keyType}].`)
        await this.pruneCacheKeys(keysForRemoval)
      },

      async pruneCacheByKeyPrefix(keyPrefix){
        let keysForRemoval = await findPrefixedKeysForRemoval(db, { keyPrefix: keyPrefix, skipRecentKeysLimit: 0 } )
        logger.debug(`Removing ${keysForRemoval.length} keys for prefix [${keyPrefix}].`)
        await this.pruneCacheKeys(keysForRemoval)
      },

      async reserveCache(key, version, totalSize) {
        logger.debug('Reserve:', { key, version })

        if (await uploadExists(db, { key, version })) {
          logger.debug(`Reserve: Already reserved. Ignoring...`, { key, version })
          return {
            cacheId: null,
          }
        }

        const driverUploadId = await driver.initiateMultiPartUpload({
          objectName: getObjectNameFromKey(key, version),
          totalSize: totalSize ?? 0,
        })
        const uploadId = randomInt(1_000_000_000, 9_999_999_999)

        await db
          .insertInto('uploads')
          .values({
            created_at: new Date().toISOString(),
            driver_upload_id: driverUploadId,
            id: uploadId.toString(),
            key,
            version,
          })
          .execute()

        logger.debug(`Reserve:`, {
          key,
          version,
          driverUploadId,
          uploadId,
        })

        this.pruneStaleCacheByType(key)

        return {
          cacheId: uploadId,
        }
      },
      async uploadChunk(uploadId, chunkStream, chunkStart, chunkEnd) {
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

        if (chunkEnd === chunkStart) {
          throw new Error('Chunk end must be greater than chunk start')
        }

        // this should be the correct chunk size except for the last chunk
        const chunkSize = Math.floor(chunkStart / (chunkEnd - chunkStart) + 1)
        // this should handle the incorrect chunk size of the last chunk by just setting it to the limit of 10000 (for s3)
        // TODO find a better way to calculate chunk size
        const partNumber = Math.min(chunkSize, 10_000)

        const objectName = getObjectNameFromKey(upload.key, upload.version)
        try {
          const { eTag } = await driver.uploadPart({
            objectName,
            uploadId: upload.driver_upload_id,
            partNumber,
            data: chunkStream,
            chunkStart,
            chunkEnd,
          })
          await db
            .insertInto('upload_parts')
            .values({
              part_number: partNumber,
              upload_id: uploadId.toString(),
              e_tag: eTag,
            })
            .execute()
        } catch (err) {
          logger.debug(
            'Upload: Error',
            { driverUploadId: upload.driver_upload_id, uploadId, chunkStart, chunkEnd, partNumber },
            err,
          )
          throw err
        }

        logger.debug('Upload:', { uploadId, chunkStart, chunkEnd, partNumber })
      },
      async commitCache(uploadId) {
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
          .orderBy('part_number asc')
          .execute()

        await db.transaction().execute(async (tx) => {
          logger.debug('Commit:', uploadId)

          await tx.deleteFrom('uploads').where('id', '=', upload.id).execute()
          await updateOrCreateKey(tx, {
            key: upload.key,
            version: upload.version,
          })

          await driver.completeMultipartUpload({
            objectName: getObjectNameFromKey(upload.key, upload.version),
            uploadId: upload.driver_upload_id,
            parts: parts.map((part) => ({
              partNumber: part.part_number,
              eTag: part.e_tag ?? undefined,
            })),
          })
        })
      },
      async getCacheEntry(keys, version) {
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
              ? await driver.createDownloadUrl({ objectName })
              : createLocalDownloadUrl(objectName),
          cacheKey: cacheKey.key,
        }
      },
      async download(objectName) {
        logger.debug('Download:', objectName)
        return driver.download({ objectName })
      },
      async pruneCaches(olderThanDays) {
        logger.debug('Prune:', {
          olderThanDays,
        })

        const keys = await findStaleKeys(db, { olderThanDays })
        if (keys.length === 0) {
          logger.debug('Prune: No caches to prune')
          return
        }

        await driver.delete({
          objectNames: keys.map((key) => getObjectNameFromKey(key.key, key.version)),
        })
        await pruneKeys(db, keys)

        logger.debug('Prune: Caches pruned', {
          olderThanDays,
        })
      },
      async pruneUploads() {
        logger.debug('Prune uploads')

        // uploads older than 24 hours
        const uploads = await db
          .selectFrom('uploads')
          .selectAll()
          .where('created_at', '<', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
          .execute()

        for (const upload of uploads) {
          await driver
            .abortMultipartUpload({
              uploadId: upload.driver_upload_id,
              objectName: getObjectNameFromKey(upload.key, upload.version),
            })
            .catch(() => {
              // noop
            })
          await db.deleteFrom('uploads').where('id', '=', upload.id)
        }
      },
    }
  } catch (err) {
    consola.error('Failed to initialize storage driver:', err)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
}

function createLocalDownloadUrl(objectName: string) {
  return `${ENV.API_BASE_URL}/download/${randomBytes(64).toString('hex')}/${objectName}`
}

export function useStorageAdapter() {
  return storage
}
