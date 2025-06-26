import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import * as R from 'remeda'
import { z } from 'zod'

import { defineStorageDriver } from '~/lib/storage/defineStorageDriver'
import { streamToBuffer } from '~/lib/utils'

export const s3Driver = defineStorageDriver({
  envSchema: z.object({
    STORAGE_S3_BUCKET: z.string().min(1),
    // AWS SDK requires an AWS_REGION to be set, even if you're using a custom endpoint
    AWS_REGION: z.string().default('us-east-1'),
  }),
  async setup(options) {
    const s3 = new S3Client({
      forcePathStyle: true,
      region: options.AWS_REGION,
    })

    try {
      await s3.send(
        new HeadBucketCommand({
          Bucket: options.STORAGE_S3_BUCKET,
        }),
      )
      // bucket exists
    } catch (err: any) {
      if (err.name === 'NotFound') {
        throw new Error(`Bucket ${options.STORAGE_S3_BUCKET} does not exist`)
      }
      throw err
    }

    const basePath = 'gh-actions-cache'

    function getObjectKey(objectName: string) {
      return `${basePath}/${objectName}`
    }

    return {
      async initiateMultiPartUpload({ objectName }) {
        const res = await s3.send(
          new CreateMultipartUploadCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: getObjectKey(objectName),
          }),
        )
        if (!res.UploadId) throw new Error('No upload id returned')
        return res.UploadId
      },
      async abortMultipartUpload({ objectName, uploadId }) {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: getObjectKey(objectName),
            UploadId: uploadId,
          }),
        )
      },
      async completeMultipartUpload({ objectName, uploadId, parts }) {
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: getObjectKey(objectName),
            UploadId: uploadId,
            MultipartUpload: {
              Parts: parts.map((part) => ({
                ETag: part.eTag,
                PartNumber: part.partNumber,
              })),
            },
          }),
        )
      },
      async uploadPart({ objectName, uploadId, partNumber, data }) {
        const buffer = await streamToBuffer(data)
        if (buffer.length === 0) return { eTag: null }

        const res = await s3.send(
          new UploadPartCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: getObjectKey(objectName),
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: buffer,
          }),
        )
        return {
          eTag: res.ETag ?? null,
        }
      },
      async download({ objectName }) {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: getObjectKey(objectName),
          }),
        )

        return response.Body as ReadableStream
      },
      async createDownloadUrl({ objectName }) {
        return getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: getObjectKey(objectName),
          }),
          {
            expiresIn: 5 * 60 * 1000, // 5 minutes
          },
        )
      },
      async delete({ objectNames }) {
        await Promise.all(
          R.chunk(objectNames, 1000).map((chunkedObjectNames) =>
            s3.send(
              new DeleteObjectsCommand({
                Bucket: options.STORAGE_S3_BUCKET,
                Delete: {
                  Objects: chunkedObjectNames.map((name) => ({ Key: getObjectKey(name) })),
                  Quiet: true,
                },
              }),
            ),
          ),
        )
      },
    }
  },
})
