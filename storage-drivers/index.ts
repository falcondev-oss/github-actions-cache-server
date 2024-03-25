import type { defineStorageDriver } from '@/lib/storage-driver'

import { filesystemDriver } from '@/storage-drivers/filesystem'
import { memoryDriver } from '@/storage-drivers/memory'
import { minioDriver } from '@/storage-drivers/minio'

const storageDrivers: Record<string, ReturnType<typeof defineStorageDriver>> = {
  minio: minioDriver,
  filesystem: filesystemDriver,
  memory: memoryDriver,
}

export function getStorageDriver(name: string) {
  return storageDrivers[name.toLowerCase()]
}
