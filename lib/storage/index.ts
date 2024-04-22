import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomInt } from 'node:crypto'

import consola from 'consola'

import { findKeyMatch, touchKey } from '~/lib/db'
import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'
import { encodeCacheKey } from '~/lib/storage/driver'
import type { StorageAdapter } from '~/lib/types'
import { getStorageDriver } from '~/storage-drivers'

export const DOWNLOAD_SECRET_KEY = randomBytes(32).toString('hex')

async function initializeStorageDriver() {
  try {
    const driverName = ENV.STORAGE_DRIVER
    const driverSetup = getStorageDriver(driverName)
    if (!driverSetup) {
      consola.error(`No storage driver found for ${driverName}`)
      process.exit(1)
    }
    logger.info(`Using storage driver: ${driverName}`)

    const driver = await driverSetup()

    const uploadBuffers = new Map<string, Buffer>()
    const cacheKeyByUploadId = new Map<number, { key: string; version: string }>()
    const commitLocks = new Set<number>()

    return <StorageAdapter>{
      async reserveCache(key, version, cacheSize) {
        logger.debug('Reserve: Reserving cache for', key, version, cacheSize)
        const bufferKey = `${key}:${version}`
        const existingBuffer = uploadBuffers.get(bufferKey)
        if (existingBuffer) {
          logger.debug(`Reserve: Cache for key ${bufferKey} already reserved. Ignoring...`)
          return {
            cacheId: null,
          }
        }

        uploadBuffers.set(bufferKey, Buffer.alloc(cacheSize))

        const uploadId = randomInt(1000000000, 9999999999)
        cacheKeyByUploadId.set(uploadId, { key, version })

        logger.debug(
          'Reserve: Cache reserved for',
          key,
          version,
          cacheSize,
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
        const buffer = uploadBuffers.get(bufferKey)
        if (!buffer) {
          logger.debug(`Commit: No buffer found for upload ${uploadId}. Ignoring...`)
          return
        }

        commitLocks.add(uploadId)
        const cacheFileName = encodeCacheKey(cacheKey.key, cacheKey.version)

        try {
          logger.debug('Commit: Committing cache for id', uploadId)
          await driver.upload(buffer, cacheFileName)
          await touchKey(cacheKey.key, cacheKey.version)
          logger.debug('Commit: Cache committed for id', uploadId)
        } finally {
          cacheKeyByUploadId.delete(uploadId)
          uploadBuffers.delete(bufferKey)
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
        const buffer = uploadBuffers.get(bufferKey)
        if (!buffer) {
          logger.debug(`Upload: No buffer found for key ${bufferKey}. Ignoring...`)
          return
        }

        logger.debug('Upload: Uploading chunks for upload', uploadId)
        let currentChunk = 0
        const bufferWriteStream = new WritableStream<Buffer>({
          write(chunk) {
            const start = chunkStart + currentChunk
            currentChunk += chunk.length
            chunk.copy(buffer, start, 0, chunk.length)
          },
        })
        await chunkStream.pipeTo(bufferWriteStream)
        logger.debug('Upload: Chunks uploaded for id', uploadId)
      },
      async pruneCaches(olderThanDays) {
        logger.debug('Prune: Pruning caches')
        await driver.prune(
          olderThanDays !== undefined && olderThanDays <= 0 ? undefined : olderThanDays,
        )
        logger.debug('Prune: Caches pruned')
      },
    }
  } catch (e) {
    consola.error('Failed to initialize storage driver:', e)
    process.exit(1)
  }
}

export const storageAdapter = await initializeStorageDriver()
