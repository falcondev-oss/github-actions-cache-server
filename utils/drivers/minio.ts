import { Buffer } from 'node:buffer'
import { createHash, randomInt } from 'node:crypto'
import { Readable } from 'node:stream'

import * as Minio from 'minio'

import { cacheIdFromKeyAndVersion, saveCacheId } from '../db'

import type { StorageDriver } from '../types'

export async function createMinioDriver(
  opts: Minio.ClientOptions & { bucketName: string },
): Promise<StorageDriver> {
  const minio = new Minio.Client(opts)
  const bucketExists = await minio.bucketExists(opts.bucketName)
  if (!bucketExists) throw new Error(`[minio-driver] Bucket ${opts.bucketName} does not exist`)

  const basePath = 'gh-actions-cache'

  const uploadBuffers = new Map<number, Buffer>()

  return {
    async reserveCache(key, cacheSize, version) {
      const cacheId =
        (await cacheIdFromKeyAndVersion(key, version)) ?? randomInt(1000000000, 9999999999)
      await saveCacheId(key, version, cacheId)

      uploadBuffers.set(cacheId, Buffer.alloc(cacheSize))
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
      const buffer = uploadBuffers.get(cacheId)
      if (!buffer)
        throw new Error(`[minio-driver] No buffer found for cacheId ${cacheId} on commit`)
      await minio.putObject(opts.bucketName, `${basePath}/${cacheId}`, buffer)

      uploadBuffers.delete(cacheId)
    },
    async download(cacheId) {
      const stream = await minio.getObject(opts.bucketName, `${basePath}/${cacheId}`)
      return Readable.toWeb(stream) as ReadableStream
    },
    async uploadChunk(cacheId, chunkStream, chunkStart) {
      const buffer = uploadBuffers.get(cacheId)
      if (!buffer)
        throw new Error(`[minio-driver] No buffer found for cacheId ${cacheId} on chunk upload`)
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
}
