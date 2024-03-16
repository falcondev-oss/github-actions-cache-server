import type { defineStorageDriver } from '@/utils/storage'

import { filesystemDriver } from '@/storage-drivers/filesystem'
import { minioDriver } from '@/storage-drivers/minio'

const storageDrivers: Record<string, ReturnType<typeof defineStorageDriver>> = {
  minio: minioDriver,
  filesystem: filesystemDriver,
}

export function getStorageDriver(name: string) {
  return storageDrivers[name.toLowerCase()]
}
