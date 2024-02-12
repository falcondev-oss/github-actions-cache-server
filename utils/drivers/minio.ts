import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import * as Minio from 'minio'

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
    reserveCache(cacheId, cacheSize) {
      uploadBuffers.set(cacheId, Buffer.alloc(cacheSize))
    },
    async commitCache(cacheId) {
      const buffer = uploadBuffers.get(cacheId)
      if (!buffer) {
        // this should only happen if multiple actions are trying to commit the same cache at the same time
        return
      }

      await minio.putObject(opts.bucketName, `${basePath}/${cacheId}`, buffer)
      uploadBuffers.delete(cacheId)
    },
    async download(cacheId) {
      const stream = await minio.getObject(opts.bucketName, `${basePath}/${cacheId}`)
      return Readable.toWeb(stream) as ReadableStream
    },
    async uploadChunk(cacheId, chunkStream, chunkStart) {
      const buffer = uploadBuffers.get(cacheId)
      if (!buffer) {
        // this should only happen if multiple actions are trying to commit the same cache at the same time
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
