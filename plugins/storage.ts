import { createMinioDriver } from '../utils/storage'

import type { StorageDriver } from '../utils/types'

let storageDriver: StorageDriver

// eslint-disable-next-line ts/no-misused-promises
export default defineNitroPlugin(async () => {
  // TODO implement more storage drivers and allow users to choose
  storageDriver = await createMinioDriver({
    bucketName: ENV.MINIO_BUCKET,
    accessKey: ENV.MINIO_ACCESS_KEY,
    endPoint: ENV.MINIO_ENDPOINT,
    secretKey: ENV.MINIO_SECRET_KEY,
    port: ENV.MINIO_PORT,
    useSSL: ENV.MINIO_USE_SSL,
  })
})

export function useStorageDriver() {
  return storageDriver
}
