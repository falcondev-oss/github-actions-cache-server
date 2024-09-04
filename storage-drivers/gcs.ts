import { Storage } from '@google-cloud/storage'
import { z } from 'zod'

import { defineStorageDriver } from '~/lib/storage/driver'

export const gcsDriver = defineStorageDriver({
  envSchema: z.object({
    STORAGE_GCS_BUCKET: z.string().min(1),
    STORAGE_GCS_SERVICEACCOUNT_KEY: z.string().optional(),
    STORAGE_GCS_ENDPOINT: z.string().optional(),
  }),
  async setup(options) {
    const gcs = new Storage({
      keyFilename: options.STORAGE_GCS_SERVICEACCOUNT_KEY,
      apiEndpoint: options.STORAGE_GCS_ENDPOINT,
    })
    const bucket = gcs.bucket(options.STORAGE_GCS_BUCKET)

    // Try to load metadata
    await bucket.getMetadata()
    const basePath = 'gh-actions-cache'

    return {
      upload(stream, objectName) {
        const file = bucket.file(`${basePath}/${objectName}`)
        return new Promise((resolve, reject) => {
          stream
            .pipe(file.createWriteStream({ resumable: false }))
            .on('error', reject)
            .on('finish', resolve)
        })
      },
      async download(objectName) {
        const file = bucket.file(`${basePath}/${objectName}`)
        return file.createReadStream()
      },
      async delete(objectNames) {
        for (const name of objectNames) {
          const file = bucket.file(`${basePath}/${name}`)
          await file.delete()
        }
      },
    }
  },
})
