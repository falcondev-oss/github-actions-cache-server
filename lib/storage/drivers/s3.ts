import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import * as R from 'remeda'

import { z } from 'zod'
import { parseEnv, StorageDriver } from '~/lib/storage/defineStorageDriver'
import { createTempDir } from '~/lib/utils'

export class S3StorageDriver extends StorageDriver {
  s3
  bucket

  constructor(opts: { s3: S3Client; bucket: string }) {
    super()
    this.s3 = opts.s3
    this.bucket = opts.bucket
  }

  static async create() {
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
    return new S3StorageDriver({ s3, bucket: options.STORAGE_S3_BUCKET })
  }

  async delete(objectNames: string[]): Promise<void> {
    await Promise.all(
      R.chunk(objectNames, 1000).map((chunkedObjectNames) =>
        this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: chunkedObjectNames.map((name) => ({ Key: this.addBaseFolderPrefix(name) })),
              Quiet: true,
            },
          }),
        ),
      ),
    )
  }

  async createReadStream(objectName: string) {
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.addBaseFolderPrefix(objectName),
      }),
    )

    return response.Body as ReadableStream
  }
  async createDownloadUrl(objectName: string) {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.addBaseFolderPrefix(objectName),
      }),
      {
        expiresIn: 5 * 60 * 1000, // 5 minutes
      },
    )
  }

  async uploadPart(opts: {
    objectName: string
    uploadId: string
    partNumber: number
    data: ReadableStream
  }) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.getUploadPartObjectName({
          uploadId: opts.uploadId,
          partNumber: opts.partNumber,
        }),
        Body: opts.data,
      }),
    )
  }

  async completeMultipartUpload(opts: {
    finalOutputObjectName: string
    uploadId: string
    partNumbers: number[]
  }) {
    const tempDir = await createTempDir()
    const outputTempFilePath = path.join(tempDir, 'output')

    const outputTempFile = await fs.open(outputTempFilePath, 'r+')

    let currentChunk = 0
    for (const partNumber of opts.partNumbers) {
      const part = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.addUploadFolderPrefix({
            uploadId: opts.uploadId,
            objectName: this.getUploadPartObjectName({
              partNumber,
              uploadId: opts.uploadId,
            }),
          }),
        }),
      )

      if (!part.Body) throw new Error(`Part ${partNumber} is missing`)

      const partStream = part.Body as ReadableStream

      const bufferWriteStream = new WritableStream<Buffer>({
        async write(chunk) {
          currentChunk += chunk.length
          await outputTempFile.write(chunk, 0, chunk.length, currentChunk)
        },
      })
      await partStream.pipeTo(bufferWriteStream)
    }

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.addBaseFolderPrefix(opts.finalOutputObjectName),
        Body: await createReadStream(outputTempFilePath),
      }),
    )

    await Promise.all([
      this.cleanupMultipartUpload(opts.uploadId),
      fs.rm(outputTempFilePath, { force: true }),
    ])
  }

  async cleanupMultipartUpload(uploadId: string) {
    const objectNames = await this.listObjectsByPrefix(this.getUploadFolderPrefix(uploadId))
    await this.delete(objectNames)
  }

  async listObjectsByPrefix(prefix: string) {
    const objects: string[] = []
    let continuationToken: string | undefined

    do {
      const response = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
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
}
