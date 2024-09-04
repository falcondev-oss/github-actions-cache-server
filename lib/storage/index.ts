import { createHash, randomBytes, randomInt } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import consola from 'consola'

import { findKeyMatch, findStaleKeys, pruneKeys, touchKey, updateOrCreateKey } from '~/lib/db'
import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'
import { encodeCacheKey } from '~/lib/storage/driver'
import type { StorageAdapter } from '~/lib/types'
import { getStorageDriver } from '~/storage-drivers'

import type { Buffer } from 'node:buffer'

export const DOWNLOAD_SECRET_KEY = randomBytes(32).toString('hex')
export const bufferDir = path.join(ENV.TEMP_DIR, 'github-actions-cache-server/upload-buffers')
await fs.mkdir(bufferDir, {
  recursive: true,
})

let storageAdapter: StorageAdapter

export async function initializeStorageAdapter() {
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

    const uploadFileBuffers = new Map<string, string>()
    const cacheKeyByUploadId = new Map<number, { key: string; version: string }>()
    const commitLocks = new Set<number>()
    const uploadChunkLocks = new Map<string, Promise<any>>()

    storageAdapter = {
      async reserveCache(key, version, cacheSize) {
        logger.debug('Reserve: Reserving cache for', key, version, cacheSize ?? '[no cache size]')
        const bufferKey = `${key}:${version}`
        if (uploadFileBuffers.has(bufferKey)) {
          logger.debug(`Reserve: Cache for key ${bufferKey} already reserved. Ignoring...`)
          return {
            cacheId: null,
          }
        }

        const uploadId = randomInt(1_000_000_000, 9_999_999_999)

        const bufferPath = path.join(bufferDir, uploadId.toString())
        uploadFileBuffers.set(bufferKey, bufferPath)
        await fs.writeFile(bufferPath, '', {
          flag: 'w',
        })

        cacheKeyByUploadId.set(uploadId, { key, version })

        logger.debug(
          'Reserve: Cache reserved for',
          key,
          version,
          cacheSize ?? '[no cache size]',
          'with upload',
          uploadId,
        )

        return {
          cacheId: uploadId,
        }
      },
      async getCacheEntry(keys, version) {
        logger.debug('Get: Getting cache entry for', keys, version)
        const primaryKey = keys[0]
        const restoreKeys = keys.length > 1 ? keys.slice(1) : undefined

        const cacheKey = await findKeyMatch({ key: primaryKey, version, restoreKeys })

        if (!cacheKey) {
          logger.debug('Get: No cache entry found for', keys, version)
          return null
        }

        await touchKey(cacheKey.key, cacheKey.version)

        const cacheFileName = encodeCacheKey(cacheKey.key, cacheKey.version)
        const hashedKey = createHash('sha256')
          .update(cacheFileName + DOWNLOAD_SECRET_KEY)
          .digest('base64url')

        logger.debug('Get: Cache entry found for', keys, version, 'with id', cacheKey.key)

        return {
          archiveLocation: `${ENV.API_BASE_URL}/download/${hashedKey}/${cacheFileName}`,
          cacheKey: cacheKey.key,
        }
      },
      async commitCache(uploadId) {
        logger.debug('Commit: Committing cache for upload', uploadId)

        if (commitLocks.has(uploadId)) {
          logger.debug(`Commit: Commit for upload ${uploadId} already in progress. Ignoring...`)
          return
        }

        const cacheKey = cacheKeyByUploadId.get(uploadId)
        if (!cacheKey) {
          logger.debug(`Commit: No cache key found for upload ${uploadId}. Ignoring...`)
          return
        }

        const bufferKey = `${cacheKey.key}:${cacheKey.version}`
        const bufferPath = uploadFileBuffers.get(bufferKey)
        if (!bufferPath) {
          logger.debug(`Commit: No buffer found for upload ${uploadId}. Ignoring...`)
          return
        }

        commitLocks.add(uploadId)
        const cacheFileName = encodeCacheKey(cacheKey.key, cacheKey.version)

        try {
          logger.debug('Commit: Committing cache for id', uploadId)
          const stream = createReadStream(bufferPath)
          await driver.upload(stream, cacheFileName)
          await updateOrCreateKey(cacheKey.key, cacheKey.version)
          logger.debug('Commit: Cache committed for id', uploadId)
        } catch (err) {
          logger.error('Commit: Failed to commit cache for id', uploadId, err)
        } finally {
          cacheKeyByUploadId.delete(uploadId)
          uploadFileBuffers.delete(bufferKey)
          await fs.rm(bufferPath)
          commitLocks.delete(uploadId)
        }
      },
      async download(objectName) {
        logger.debug('Download: Downloading', objectName)
        return driver.download(objectName)
      },
      async uploadChunk(uploadId, chunkStream, chunkStart) {
        logger.debug('Upload: Uploading chunk for upload', uploadId)
        const cacheKey = cacheKeyByUploadId.get(uploadId)
        if (!cacheKey) {
          logger.debug(`Upload: No cache key found for upload ${uploadId}. Ignoring...`)
          return
        }

        const bufferKey = `${cacheKey.key}:${cacheKey.version}`
        const bufferPath = uploadFileBuffers.get(bufferKey)
        if (!bufferPath) {
          logger.debug(`Upload: No buffer found for key ${bufferKey}. Ignoring...`)
          return
        }

        const uploadChunkLock = uploadChunkLocks.get(bufferKey)
        if (uploadChunkLock) await uploadChunkLock

        uploadChunkLocks.set(
          bufferKey,
          (async () => {
            const file = await fs.open(bufferPath, 'r+')

            let currentChunk = 0
            const bufferWriteStream = new WritableStream<Buffer>({
              async write(chunk) {
                const start = chunkStart + currentChunk
                currentChunk += chunk.length
                await file.write(chunk, 0, chunk.length, start)
              },
            })
            await chunkStream.pipeTo(bufferWriteStream)
            await file.close()
          })(),
        )

        await uploadChunkLocks.get(bufferKey)
        uploadChunkLocks.delete(bufferKey)

        logger.debug('Upload: Chunks uploaded for id', uploadId)
      },
      async pruneCaches(olderThanDays) {
        logger.debug('Prune: Pruning caches')

        const keys = await findStaleKeys(olderThanDays)
        await driver.delete(keys.map((key) => encodeCacheKey(key.key, key.version)))
        await pruneKeys(keys)

        logger.debug('Prune: Caches pruned')
      },
    }
  } catch (err) {
    consola.error('Failed to initialize storage driver:', err)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
}

export function useStorageAdapter() {
  return storageAdapter
}
