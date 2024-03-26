import * as Minio from 'minio'
import { z } from 'zod'

import { defineStorageDriver } from '@/lib/storage-driver'

export const s3Driver = defineStorageDriver({
  envSchema: z.object({
    S3_BUCKET: z.string().min(1),
    S3_ENDPOINT: z.string().min(1).default('s3.amazonaws.com'),
    S3_REGION: z.string().min(1).default(Minio.DEFAULT_REGION),
    S3_PORT: z.coerce.number().positive().default(443),
    S3_USE_SSL: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
  }),
  async setup(options) {
    const minio = new Minio.Client({
      accessKey: options.S3_ACCESS_KEY,
      endPoint: options.S3_ENDPOINT,
      region: options.S3_REGION,
      secretKey: options.S3_SECRET_KEY,
      port: options.S3_PORT,
      useSSL: options.S3_USE_SSL,
    })
    const bucketExists = await minio.bucketExists(options.S3_BUCKET)
    if (!bucketExists) throw new Error(`Bucket ${options.S3_BUCKET} does not exist`)

    const basePath = 'gh-actions-cache'

    return {
      async upload(buffer, objectName) {
        await minio.putObject(options.S3_BUCKET, `${basePath}/${objectName}`, buffer)
      },
      async download(objectName) {
        const stream = await minio.getObject(options.S3_BUCKET, `${basePath}/${objectName}`)
        return stream
      },
      async prune() {
        const objectStream = minio.listObjects(options.S3_BUCKET, basePath, true)
        for await (const obj of objectStream) {
          const item = obj as Minio.BucketItem
          if (!item.name) continue
          await minio.removeObject(options.S3_BUCKET, item.name)
        }
      },
    }
  },
})
