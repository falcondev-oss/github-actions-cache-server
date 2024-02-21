import { Readable } from 'node:stream'

import * as Minio from 'minio'

import type { StorageDriver } from '@/utils/types'

export async function createMinioDriver(
  opts: Minio.ClientOptions & { bucketName: string },
): Promise<StorageDriver> {
  const minio = new Minio.Client(opts)
  const bucketExists = await minio.bucketExists(opts.bucketName)
  if (!bucketExists) throw new Error(`[minio-driver] Bucket ${opts.bucketName} does not exist`)

  const basePath = 'gh-actions-cache'

  return {
    async upload(buffer, objectName) {
      await minio.putObject(opts.bucketName, `${basePath}/${objectName}`, buffer)
    },
    async download(cacheId) {
      const stream = await minio.getObject(opts.bucketName, `${basePath}/${cacheId}`)
      return Readable.toWeb(stream) as ReadableStream
    },
  }
}
