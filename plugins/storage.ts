import { createHash, randomInt } from 'node:crypto'

import { cacheIdFromKeyAndVersion, saveCacheId } from '../utils/db'

import type { StorageAdapter } from '@/utils/types'

import { createMinioDriver } from '@/utils/storage'

let storageAdapter: StorageAdapter

// eslint-disable-next-line ts/no-misused-promises
export default defineNitroPlugin(async () => {
  // TODO implement more storage drivers and allow users to choose
  const driver = await createMinioDriver({
    bucketName: ENV.MINIO_BUCKET,
    accessKey: ENV.MINIO_ACCESS_KEY,
    endPoint: ENV.MINIO_ENDPOINT,
    secretKey: ENV.MINIO_SECRET_KEY,
    port: ENV.MINIO_PORT,
    useSSL: ENV.MINIO_USE_SSL,
  })

  storageAdapter = {
    async reserveCache(key, cacheSize, version) {
      let cacheId = await cacheIdFromKeyAndVersion(key, version)
      if (!cacheId) {
        cacheId = randomInt(1000000000, 9999999999)
        await saveCacheId(key, version, cacheId)
      }

      await driver.reserveCache(cacheId, cacheSize)
      return {
        cacheId,
      }
    },
    async getCacheEntry(keys, version) {
      let cacheId: number | null = null
      for (const key of keys) cacheId = await cacheIdFromKeyAndVersion(key, version)

      if (!cacheId) return null

      const hashedKey = createHash('sha256')
        .update(cacheId.toString() + ENV.SECRET)
        .digest('base64url')

      return {
        archiveLocation: `${ENV.BASE_URL}/download/${hashedKey}/${cacheId}`,
        cacheKey: cacheId.toString(),
      }
    },
    async commitCache(cacheId) {
      await driver.commitCache(cacheId)
    },
    async download(cacheId) {
      return driver.download(cacheId)
    },
    async uploadChunk(cacheId, chunkStream, chunkStart, chunkEnd) {
      await driver.uploadChunk(cacheId, chunkStream, chunkStart, chunkEnd)
    },
  }
})

export function useStorageDriver() {
  return storageAdapter
}
