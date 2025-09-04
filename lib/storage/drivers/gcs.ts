import type { StorageDriver } from '~/lib/storage/storage-driver'
import { pipeline } from 'node:stream/promises'
import { Storage } from '@google-cloud/storage'
import { z } from 'zod'
import { BASE_FOLDER, parseEnv, UPLOAD_FOLDER } from '~/lib/storage/storage-driver'

export const GCSStorageDriver = {
  async create() {
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

    async function deleteMany(objectNames: string[]) {
      await Promise.all(
        objectNames.map((objectName) => bucket.file(objectName).delete({ ignoreNotFound: true })),
      )
    }

    return <StorageDriver>{
      async delete(cacheFileNames) {
        await deleteMany(cacheFileNames.map((fileName) => `${BASE_FOLDER}/${fileName}`))
      },
      async createReadStream(cacheFileName: string) {
        const file = bucket.file(`${BASE_FOLDER}/${cacheFileName}`)
        if (!(await file.exists().then((res) => res[0]))) return null
        return file.createReadStream()
      },

      async createDownloadUrl(cacheFileName: string) {
        return bucket
          .file(`${BASE_FOLDER}/${cacheFileName}`)
          .getSignedUrl({
            action: 'read',
            expires: Date.now() + 5 * 60 * 1000, // 5 minutes
          })
          .then((res) => res[0])
      },

      async uploadPart(opts) {
        await bucket
          .file(`${BASE_FOLDER}/${UPLOAD_FOLDER}/${opts.uploadId}/part_${opts.partNumber}`)
          .save(opts.data)
      },

      async completeMultipartUpload(opts) {
        const cacheFile = bucket.file(`${BASE_FOLDER}/${opts.cacheFileName}`)
        const writeStream = cacheFile.createWriteStream()

        for (const partNumber of opts.partNumbers) {
          const readStream = bucket
            .file(`${BASE_FOLDER}/${UPLOAD_FOLDER}/${opts.uploadId}/part_${partNumber}`)
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
      },

      async cleanupMultipartUpload(uploadId) {
        await bucket.deleteFiles({
          prefix: `${BASE_FOLDER}/${UPLOAD_FOLDER}/${uploadId}`,
        })
      },
    }
  },
}
