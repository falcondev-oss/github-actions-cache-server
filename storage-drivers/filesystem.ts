import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { ENV } from '@/lib/env'
import { defineStorageDriver } from '@/lib/storage-driver'

export const filesystemDriver = defineStorageDriver({
  envSchema: z.object({}),
  async setup() {
    const basePath = path.join(ENV.DATA_DIR, 'filesystem-driver-storage')

    await fs.mkdir(basePath, {
      recursive: true,
    })

    return {
      async upload(buffer, objectName) {
        await fs.writeFile(path.join(basePath, objectName), buffer)
      },
      async download(objectName) {
        const stream = createReadStream(path.join(basePath, objectName))
        return stream
      },
    }
  },
})
