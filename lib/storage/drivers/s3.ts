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
import { z } from 'zod'

import { defineStorageDriver } from '~/lib/storage/defineStorageDriver'
import { streamToBuffer } from '~/lib/utils'

export const s3Driver = defineStorageDriver({
  envSchema: z.object({
    STORAGE_S3_BUCKET: z.string().min(1),
    STORAGE_S3_ENDPOINT: z.string().optional(),
    STORAGE_S3_REGION: z.string().min(1).default('us-east-1'),
    STORAGE_S3_PORT: z.coerce.number().positive().optional(),
    STORAGE_S3_USE_SSL: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    STORAGE_S3_ACCESS_KEY: z.string().optional(),
    STORAGE_S3_SECRET_KEY: z.string().optional(),
    AWS_REGION: z.string().optional(),
    AWS_DEFAULT_REGION: z.string().optional(),
  }),
  async setup(options) {
    const protocol = options.STORAGE_S3_USE_SSL ? 'https' : 'http'
    const port = options.STORAGE_S3_PORT ? `:${options.STORAGE_S3_PORT}` : ''
    let credentials

    if (options.STORAGE_S3_ACCESS_KEY && options.STORAGE_S3_SECRET_KEY) {
      credentials = {
        secretAccessKey: options.STORAGE_S3_SECRET_KEY,
        accessKeyId: options.STORAGE_S3_ACCESS_KEY,
      }
    }

    const s3 = new S3Client({
      credentials,
      endpoint: options.STORAGE_S3_ENDPOINT
        ? `${protocol}://${options.STORAGE_S3_ENDPOINT}${port}`
        : undefined,
      region: options.AWS_REGION ?? options.AWS_DEFAULT_REGION ?? options.STORAGE_S3_REGION,
      forcePathStyle: true,
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
        const res = await s3.send(
          new UploadPartCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: getObjectKey(objectName),
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: await streamToBuffer(data),
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
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Delete: {
              Objects: objectNames.map((name) => ({ Key: getObjectKey(name) })),
              Quiet: true,
            },
          }),
        )
      },
    }
  },
})
