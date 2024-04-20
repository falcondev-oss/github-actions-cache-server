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
      async prune(olderThanDays) {
        if (olderThanDays === undefined) {
          await fs.rm(basePath, {
            recursive: true,
            force: true,
          })
          await fs.mkdir(basePath, {
            recursive: true,
          })
          return
        }

        await recursivePrune(olderThanDays, basePath)
      },
    }
  },
})

async function recursivePrune(olderThanDays: number, basePath: string) {
  const now = Date.now()

  for await (const entry of await fs.opendir(basePath)) {
    const entryPath = path.join(basePath, entry.name)
    if (entry.isDirectory()) {
      await recursivePrune(olderThanDays, entryPath)
      continue
    }
    if (!entry.isFile()) continue

    const { mtimeMs } = await fs.stat(entryPath)
    if (now - mtimeMs > olderThanDays * 24 * 60 * 60 * 1000) {
      await fs.rm(entryPath, {
        recursive: true,
        force: true,
      })
    }
  }
}
