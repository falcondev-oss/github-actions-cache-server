import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import consola from 'consola'
import * as Minio from 'minio'

import type { StorageDriver } from '@/utils/types'

export async function createMinioDriver(
  opts: Minio.ClientOptions & { bucketName: string },
): Promise<StorageDriver> {
  const minio = new Minio.Client(opts)
  const bucketExists = await minio.bucketExists(opts.bucketName)
  if (!bucketExists) throw new Error(`[minio-driver] Bucket ${opts.bucketName} does not exist`)

  const basePath = 'gh-actions-cache'
  const uploadBuffers = new Map<number, Buffer>()
  const commitLocks = new Set<number>()

  return {
    reserveCache(cacheId, cacheSize) {
      if (uploadBuffers.has(cacheId)) {
        consola.info(`[minio/reserve] Cache for key ${cacheId} already reserved. Ignoring...`)
        return false
      }
      uploadBuffers.set(cacheId, Buffer.alloc(cacheSize))
      return true
    },
    async commitCache(cacheId) {
      if (commitLocks.has(cacheId)) {
        consola.info(`[minio/commit] Commit for key ${cacheId} already in progress. Ignoring...`)
        return
      }

      const buffer = uploadBuffers.get(cacheId)
      if (!buffer) {
        consola.info(`[minio/commit] No buffer found for key ${cacheId}. Ignoring...`)
        return
      }

      commitLocks.add(cacheId)

      try {
        await minio.putObject(opts.bucketName, `${basePath}/${cacheId}`, buffer)
      } finally {
        uploadBuffers.delete(cacheId)
        commitLocks.delete(cacheId)
      }
    },
    async download(cacheId) {
      const stream = await minio.getObject(opts.bucketName, `${basePath}/${cacheId}`)
      return Readable.toWeb(stream) as ReadableStream
    },
    async uploadChunk(cacheId, chunkStream, chunkStart) {
      const buffer = uploadBuffers.get(cacheId)
      if (!buffer) {
        consola.info(`[minio/upload] No buffer found for key ${cacheId}. Ignoring...`)
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
}
