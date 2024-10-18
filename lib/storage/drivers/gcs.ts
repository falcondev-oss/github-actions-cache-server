import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { Storage } from '@google-cloud/storage'
import { z } from 'zod'

import { defineStorageDriver } from '~/lib/storage/defineStorageDriver'

/**
 * ? Google cloud doesn't support out-of-order multipart uploads so we need to use a temp folder
 */
export const gcsDriver = defineStorageDriver({
  envSchema: z.object({
    STORAGE_GCS_BUCKET: z.string().min(1),
    STORAGE_GCS_SERVICE_ACCOUNT_KEY: z.string().optional(),
    STORAGE_GCS_ENDPOINT: z.string().optional(),
  }),
  async setup(options) {
    const gcs = new Storage({
      keyFilename: options.STORAGE_GCS_SERVICE_ACCOUNT_KEY,
      apiEndpoint: options.STORAGE_GCS_ENDPOINT,
    })
    const bucket = gcs.bucket(options.STORAGE_GCS_BUCKET)

    // Try to load metadata
    await bucket.getMetadata()
    const basePath = 'gh-actions-cache'

    function getFile(objectName: string) {
      return bucket.file(`${basePath}/${objectName}`)
    }

    function getUploadTempFile(uploadId: string, partNumber: number) {
      return bucket.file(path.join(getUploadFolderPath(uploadId), `part_${partNumber}`))
    }

    function getUploadFolderPath(uploadId: string) {
      return path.join(basePath, '.uploads', uploadId)
    }
    return {
      async initiateMultiPartUpload() {
        return randomUUID()
      },
      async abortMultipartUpload({ uploadId }) {
        await bucket.deleteFiles({ prefix: getUploadFolderPath(uploadId) })
      },
      async uploadPart({ uploadId, partNumber, data }) {
        await getUploadTempFile(uploadId, partNumber).save(data)
        return { eTag: null }
      },
      async completeMultipartUpload({ objectName, uploadId, parts }) {
        const [files] = await bucket.getFiles({ prefix: getUploadFolderPath(uploadId) })

        const filesByPartNumber = Object.fromEntries(
          files.map((file) => [file.name.split('_')[1], file]),
        )

        const finalFile = getFile(objectName)
        const writeStream = finalFile.createWriteStream()

        for (const part of parts) {
          const partFile = filesByPartNumber[part.partNumber.toString()]
          if (!partFile) throw new Error(`Part ${part.partNumber} is missing`)

          const readStream = partFile.createReadStream()

          await pipeline(readStream, writeStream, { end: false })
        }

        writeStream.end()

        // Wait for the write to complete
        await new Promise((resolve, reject) => {
          writeStream.on('finish', resolve)
          writeStream.on('error', reject)
        })

        // Clean up temp files
        await bucket.deleteFiles({ prefix: getUploadFolderPath(uploadId) })
      },
      async download({ objectName }) {
        return getFile(objectName).createReadStream()
      },
      async createDownloadUrl({ objectName }) {
        return getFile(objectName)
          .getSignedUrl({
            action: 'read',
            expires: Date.now() + 5 * 60 * 1000, // 5 minutes
          })
          .then((res) => res[0])
      },
      async delete({ objectNames }) {
        for (const name of objectNames) {
          await getFile(name).delete()
        }
      },
    }
  },
})
