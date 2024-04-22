import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { z } from 'zod'

import { defineStorageDriver } from '~/lib/storage/driver'

export const memoryDriver = defineStorageDriver({
  envSchema: z.object({}),
  async setup() {
    const storage = new Map<string, Buffer>()
    return {
      upload(buffer, objectName) {
        storage.set(objectName, buffer)
      },
      async download(objectName) {
        return Readable.from(storage.get(objectName) ?? Buffer.from(''))
      },
      async prune(names) {
        for (const name of names) storage.delete(name)
      },
    }
  },
})
