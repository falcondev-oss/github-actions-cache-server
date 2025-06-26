import type { Bucket } from '@google-cloud/storage'

import { pipeline } from 'node:stream/promises'
import { Storage } from '@google-cloud/storage'
import { z } from 'zod'
import { parseEnv, StorageDriver } from '~/lib/storage/defineStorageDriver'

export class GCSStorageDriver extends StorageDriver {
  bucket
  gcs

  constructor(opts: { gcs: Storage; bucket: Bucket }) {
    super()
    this.gcs = opts.gcs
    this.bucket = opts.bucket
  }

  static async create() {
    const options = parseEnv(
      z.object({
        STORAGE_GCS_BUCKET: z.string().min(1),
        STORAGE_GCS_SERVICE_ACCOUNT_KEY: z.string().optional(),
        STORAGE_GCS_ENDPOINT: z.string().optional(),
      }),
    )

    const gcs = new Storage({
      keyFilename: options.STORAGE_GCS_SERVICE_ACCOUNT_KEY,
      apiEndpoint: options.STORAGE_GCS_ENDPOINT,
    })
    const bucket = gcs.bucket(options.STORAGE_GCS_BUCKET)

    // Try to load metadata
    await bucket.getMetadata()

    return new GCSStorageDriver({
      gcs,
      bucket,
    })
  }

  async delete(objectNames: string[]) {
    await Promise.all(
      objectNames.map((name) => this.bucket.file(this.addBaseFolderPrefix(name)).delete()),
    )
  }
  async createReadStream(objectName: string) {
    return this.bucket.file(this.addBaseFolderPrefix(objectName)).createReadStream()
  }

  async createDownloadUrl?(objectName: string) {
    return this.bucket
      .file(this.addBaseFolderPrefix(objectName))
      .getSignedUrl({
        action: 'read',
        expires: Date.now() + 5 * 60 * 1000, // 5 minutes
      })
      .then((res) => res[0])
  }

  async uploadPart(opts: { uploadId: string; partNumber: number; data: ReadableStream }) {
    await this.bucket
      .file(
        this.getUploadPartObjectName({
          uploadId: opts.uploadId,
          partNumber: opts.partNumber,
        }),
      )
      .save(opts.data)
  }

  async completeMultipartUpload(opts: {
    finalOutputObjectName: string
    uploadId: string
    partNumbers: number[]
  }) {
    const finalFile = this.bucket.file(this.addBaseFolderPrefix(opts.finalOutputObjectName))
    const writeStream = finalFile.createWriteStream()

    for (const partNumber of opts.partNumbers) {
      const readStream = this.bucket
        .file(
          this.getUploadPartObjectName({
            partNumber,
            uploadId: opts.uploadId,
          }),
        )
        .createReadStream()

      await pipeline(readStream, writeStream, { end: false })
    }

    writeStream.end()

    // Wait for the write to complete
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
    })

    // Clean up temp files
    await this.cleanupMultipartUpload(opts.uploadId)
  }

  async cleanupMultipartUpload(uploadId: string) {
    await this.bucket.deleteFiles({
      prefix: this.getUploadFolderPrefix(uploadId),
    })
  }
}
