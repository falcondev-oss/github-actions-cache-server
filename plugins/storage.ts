import { Buffer } from 'node:buffer'
import { createHash, randomInt } from 'node:crypto'

import consola from 'consola'

import type { StorageAdapter } from '@/utils/types'

import { findKeyMatch, touchKey } from '@/db/client'
import { createMinioDriver, encodeCacheKey } from '@/utils/storage'

let storageAdapter: StorageAdapter

// eslint-disable-next-line ts/no-misused-promises
export default defineNitroPlugin(async () => {
  try {
    // TODO implement more storage drivers and allow users to choose
    const driver = await createMinioDriver({
      bucketName: ENV.MINIO_BUCKET,
      accessKey: ENV.MINIO_ACCESS_KEY,
      endPoint: ENV.MINIO_ENDPOINT,
      secretKey: ENV.MINIO_SECRET_KEY,
      port: ENV.MINIO_PORT,
      useSSL: ENV.MINIO_USE_SSL,
    })

    const uploadBuffers = new Map<string, Buffer>()
    const cacheKeyByCacheId = new Map<number, { key: string; version: string }>()
    const commitLocks = new Set<number>()

    storageAdapter = {
      async reserveCache(key, version, cacheSize) {
        const bufferKey = `${key}:${version}`
        const existingBuffer = uploadBuffers.get(bufferKey)
        if (existingBuffer) {
          consola.info(`[reserve] Cache for key ${bufferKey} already reserved. Ignoring...`)
          return {
            cacheId: null,
          }
        }

        uploadBuffers.set(bufferKey, Buffer.alloc(cacheSize))

        const cacheId = randomInt(1000000000, 9999999999)
        cacheKeyByCacheId.set(cacheId, { key, version })

        return {
          cacheId,
        }
      },
      async getCacheEntry(keys, version) {
        const primaryKey = keys[0]
        const restoreKeys = keys.length > 1 ? keys.slice(1) : undefined

        const cacheKey = await findKeyMatch({ key: primaryKey, version, restoreKeys })

        if (!cacheKey) return null

        const cacheFileName = encodeCacheKey(cacheKey.key, cacheKey.version)
        const hashedKey = createHash('sha256')
          .update(cacheFileName + ENV.SECRET)
          .digest('base64url')

        return {
          archiveLocation: `${ENV.BASE_URL}/download/${hashedKey}/${cacheFileName}`,
          cacheKey: cacheKey.key,
        }
      },
      async commitCache(cacheId) {
        if (commitLocks.has(cacheId)) {
          consola.info(`[commit] Commit for id ${cacheId} already in progress. Ignoring...`)
          return
        }

        const cacheKey = cacheKeyByCacheId.get(cacheId)
        if (!cacheKey) {
          consola.info(`[commit] No cache key found for id ${cacheId}. Ignoring...`)
          return
        }

        const bufferKey = `${cacheKey.key}:${cacheKey.version}`
        const buffer = uploadBuffers.get(bufferKey)
        if (!buffer) {
          consola.info(`[commit] No buffer found for key ${cacheId}. Ignoring...`)
          return
        }

        commitLocks.add(cacheId)
        const cacheFileName = encodeCacheKey(cacheKey.key, cacheKey.version)

        try {
          await driver.upload(buffer, cacheFileName)
          await touchKey(cacheKey.key, cacheKey.version)
        } finally {
          cacheKeyByCacheId.delete(cacheId)
          uploadBuffers.delete(bufferKey)
          commitLocks.delete(cacheId)
        }
      },
      async download(objectName) {
        return driver.download(objectName)
      },
      async uploadChunk(cacheId, chunkStream, chunkStart) {
        const cacheKey = cacheKeyByCacheId.get(cacheId)
        if (!cacheKey) {
          consola.info(`[upload] No cache key found for id ${cacheId}. Ignoring...`)
          return
        }

        const bufferKey = `${cacheKey.key}:${cacheKey.version}`
        const buffer = uploadBuffers.get(bufferKey)
        if (!buffer) {
          consola.info(`[upload] No buffer found for key ${bufferKey}. Ignoring...`)
          return
        }

        let currentChunk = 0
        const bufferWriteStream = new WritableStream<Buffer>({
          write(chunk) {
            const start = chunkStart + currentChunk
            currentChunk += chunk.length
            chunk.copy(buffer, start, 0, chunk.length)
          },
        })
        await chunkStream.pipeTo(bufferWriteStream)
      },
    }
  } catch (e) {
    console.error('Failed to initialize storage driver:', e)
    process.exit(1)
  }
})

export function useStorageDriver() {
  return storageAdapter
}
