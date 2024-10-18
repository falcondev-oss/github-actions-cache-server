import type { defineStorageDriver } from '~/lib/storage/defineStorageDriver'
import { filesystemDriver } from '~/lib/storage/drivers/filesystem'
import { gcsDriver } from '~/lib/storage/drivers/gcs'
import { s3Driver } from '~/lib/storage/drivers/s3'

const storageDrivers = {
  s3: s3Driver,
  gcs: gcsDriver,
  filesystem: filesystemDriver,
} as const satisfies Record<string, ReturnType<typeof defineStorageDriver>>

export type StorageDriverName = keyof typeof storageDrivers

export function getStorageDriver(name: string) {
  return storageDrivers[name as StorageDriverName]
}
