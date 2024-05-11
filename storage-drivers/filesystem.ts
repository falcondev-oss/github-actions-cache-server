import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { defineStorageDriver } from '~/lib/storage/driver'

export const filesystemDriver = defineStorageDriver({
  envSchema: z.object({
    STORAGE_FILESYSTEM_PATH: z.string().default('.data/storage/filesystem'),
  }),
  async setup({ STORAGE_FILESYSTEM_PATH }) {
    const basePath = STORAGE_FILESYSTEM_PATH

    await fs.mkdir(basePath, {
      recursive: true,
    })

    return {
      async upload(stream, objectName) {
        await fs.writeFile(path.join(basePath, objectName), stream)
      },
      async download(objectName) {
        const stream = createReadStream(path.join(basePath, objectName))
        return stream
      },
      async delete(objectNames) {
        for (const name of objectNames) {
          await fs.rm(path.join(basePath, name), {
            recursive: true,
            force: true,
          })
        }
      },
    }
  },
})
