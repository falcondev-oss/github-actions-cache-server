import { FilesystemStorageDriver } from './filesystem'
import { GCSStorageDriver } from './gcs'
import { S3StorageDriver } from './s3'

const storageDrivers = {
  s3: S3StorageDriver,
  gcs: GCSStorageDriver,
  filesystem: FilesystemStorageDriver,
} as const

export type StorageDriverName = keyof typeof storageDrivers

export function getStorageDriver(name: string) {
  return storageDrivers[name as StorageDriverName]
}
