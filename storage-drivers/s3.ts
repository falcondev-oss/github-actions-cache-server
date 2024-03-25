import { S3 } from '@aws-sdk/client-s3'
import { z } from 'zod'

import type { ListObjectsCommandOutput } from '@aws-sdk/client-s3/dist-types/commands/ListObjectsCommand'
import type { Readable } from 'node:stream'

import { defineStorageDriver } from '@/lib/storage-driver'

export const s3Driver = defineStorageDriver({
  envSchema: z.object({
    S3_BUCKET: z.string().min(1),
    S3_REGION: z.string().min(1),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
  }),
  async setup(options) {
    const s3 = new S3({
      region: options.S3_REGION,
      credentials: {
        accessKeyId: options.S3_ACCESS_KEY,
        secretAccessKey: options.S3_SECRET_KEY,
      },
    })

    // Make sure the bucket exists and is accessible
    await s3.headBucket({
      Bucket: options.S3_BUCKET,
    })

    const basePath = 'gh-actions-cache'

    return {
      async upload(buffer, objectName) {
        await s3.putObject({
          Bucket: options.S3_BUCKET,
          Key: `${basePath}/${objectName}`,
          Body: buffer,
        })
      },
      async download(objectName) {
        const response = await s3.getObject({
          Bucket: options.S3_BUCKET,
          Key: `${basePath}/${objectName}`,
        })

        return response.Body as Readable
      },
      async prune() {
        let nextMarker: string | null = null

        while (nextMarker) {
          const response: ListObjectsCommandOutput = await s3.listObjects({
            Bucket: options.S3_BUCKET,
            Prefix: basePath,
            Marker: nextMarker,
          })

          for (const obj of response.Contents!) {
            if (!obj.Key) continue

            await s3.deleteObject({
              Bucket: options.S3_BUCKET,
              Key: obj.Key,
            })
          }

          nextMarker = response.IsTruncated ? response.Contents!.slice(-1)[0].Key! : null
        }
      },
    }
  },
})
