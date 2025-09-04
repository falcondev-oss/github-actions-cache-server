import type { StorageDriver } from '~/lib/storage/storage-driver'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import * as R from 'remeda'
import { z } from 'zod'
import { BASE_FOLDER, parseEnv, UPLOAD_FOLDER } from '~/lib/storage/storage-driver'
import { createTempDir } from '~/lib/utils'

export const S3StorageDriver = {
  async create() {
    const options = parseEnv(
      z.object({
        STORAGE_S3_BUCKET: z.string().min(1),
        // AWS SDK requires an AWS_REGION to be set, even if you're using a custom endpoint
        AWS_REGION: z.string().default('us-east-1'),
      }),
    )

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

    async function listObjectsByPrefix(prefix: string) {
      const objects: string[] = []
      let continuationToken: string | undefined

      do {
        const response = await s3.send(
          new ListObjectsV2Command({
            Bucket: options.STORAGE_S3_BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )

        if (response.Contents) {
          for (const object of response.Contents) {
            if (object.Key) {
              objects.push(object.Key)
            }
          }
        }

        continuationToken = response.NextContinuationToken
      } while (continuationToken)

      return objects
    }

    async function deleteMany(objectNames: string[]) {
      return await Promise.all(
        R.chunk(objectNames, 1000).map((chunkedObjectNames) =>
          s3.send(
            new DeleteObjectsCommand({
              Bucket: options.STORAGE_S3_BUCKET,
              Delete: {
                Objects: chunkedObjectNames.map((objectName) => ({
                  Key: objectName,
                })),
                Quiet: true,
              },
            }),
          ),
        ),
      )
    }

    return <StorageDriver>{
      async delete(cacheFileNames) {
        await deleteMany(cacheFileNames.map((fileName) => `${BASE_FOLDER}/${fileName}`))
      },

      async createReadStream(cacheFileName) {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: `${BASE_FOLDER}/${cacheFileName}`,
          }),
        )

        return response.Body as ReadableStream
      },
      async createDownloadUrl(cacheFileName) {
        return getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: `${BASE_FOLDER}/${cacheFileName}`,
          }),
          {
            expiresIn: 5 * 60 * 1000, // 5 minutes
          },
        )
      },
      async uploadPart(opts) {
        const upload = new Upload({
          client: s3,
          params: {
            Bucket: options.STORAGE_S3_BUCKET,
            Key: `${BASE_FOLDER}/${UPLOAD_FOLDER}/${opts.uploadId}/part_${opts.partNumber}`,
            Body: opts.data,
          },
          partSize: 64 * 1024 * 1024, // 64 MB
          queueSize: 1,
        })
        await upload.done()
      },

      async completeMultipartUpload(opts) {
        const tempDir = await createTempDir()
        const outputTempFilePath = path.join(tempDir, 'output')

        await fs.writeFile(outputTempFilePath, '')
        const outputTempFile = await fs.open(outputTempFilePath, 'r+')

        let currentChunk = 0
        for (const partNumber of opts.partNumbers) {
          const part = await s3.send(
            new GetObjectCommand({
              Bucket: options.STORAGE_S3_BUCKET,
              Key: `${BASE_FOLDER}/${UPLOAD_FOLDER}/${opts.uploadId}/part_${partNumber}`,
            }),
          )

          if (!part.Body) throw new Error(`Part ${partNumber} is missing`)

          const partStream = part.Body.transformToWebStream()
          const bufferWriteStream = new WritableStream<Buffer>({
            async write(chunk) {
              const start = currentChunk
              currentChunk += chunk.length
              await outputTempFile.write(chunk, 0, chunk.length, start)
            },
          })
          await partStream.pipeTo(bufferWriteStream)
        }

        await outputTempFile.close()

        const readStream = createReadStream(outputTempFilePath)
        const upload = new Upload({
          client: s3,
          params: {
            Bucket: options.STORAGE_S3_BUCKET,
            Key: `${BASE_FOLDER}/${opts.cacheFileName}`,
            Body: readStream,
          },
          partSize: 64 * 1024 * 1024, // 64 MB
          queueSize: 1,
        })
        await upload.done()

        await Promise.all([
          this.cleanupMultipartUpload(opts.uploadId),
          fs.rm(outputTempFilePath, { force: true }),
        ])
      },
      async cleanupMultipartUpload(uploadId) {
        const objectNames = await listObjectsByPrefix(`${BASE_FOLDER}/${UPLOAD_FOLDER}/${uploadId}`)
        await deleteMany(objectNames)
      },
    }
  },
}
