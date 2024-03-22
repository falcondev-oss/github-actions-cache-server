import * as Minio from 'minio'
import { z } from 'zod'

import { defineStorageDriver } from '@/lib/storage-driver'

export const minioDriver = defineStorageDriver({
  envSchema: z.object({
    MINIO_BUCKET: z.string().min(1),
    MINIO_ENDPOINT: z.string().min(1),
    MINIO_PORT: z.coerce.number().positive(),
    MINIO_USE_SSL: z.string().transform((v) => v === 'true'),
    MINIO_ACCESS_KEY: z.string().min(1),
    MINIO_SECRET_KEY: z.string().min(1),
  }),
  async setup(options) {
    const minio = new Minio.Client({
      accessKey: options.MINIO_ACCESS_KEY,
      endPoint: options.MINIO_ENDPOINT,
      secretKey: options.MINIO_SECRET_KEY,
      port: options.MINIO_PORT,
      useSSL: options.MINIO_USE_SSL,
    })
    const bucketExists = await minio.bucketExists(options.MINIO_BUCKET)
    if (!bucketExists) throw new Error(`Bucket ${options.MINIO_BUCKET} does not exist`)

    const basePath = 'gh-actions-cache'

    return {
      async upload(buffer, objectName) {
        await minio.putObject(options.MINIO_BUCKET, `${basePath}/${objectName}`, buffer)
      },
      async download(objectName) {
        const stream = await minio.getObject(options.MINIO_BUCKET, `${basePath}/${objectName}`)
        return stream
      },
    }
  },
})
