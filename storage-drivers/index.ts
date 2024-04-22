import type { defineStorageDriver } from '~/lib/storage/driver'
import { filesystemDriver } from '~/storage-drivers/filesystem'
import { memoryDriver } from '~/storage-drivers/memory'
import { s3Driver } from '~/storage-drivers/s3'

const storageDrivers = {
  s3: s3Driver,
  filesystem: filesystemDriver,
  memory: memoryDriver,
} as const satisfies Record<string, ReturnType<typeof defineStorageDriver>>

export type StorageDriverName = keyof typeof storageDrivers

export function getStorageDriver(name: string) {
  return storageDrivers[name as StorageDriverName]
}
