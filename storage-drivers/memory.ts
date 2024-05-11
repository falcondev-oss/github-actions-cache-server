import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { z } from 'zod'

import { defineStorageDriver } from '~/lib/storage/driver'

export const memoryDriver = defineStorageDriver({
  envSchema: z.object({}),
  async setup() {
    const storage = new Map<string, Buffer>()
    return {
      async upload(stream, objectName) {
        const buffer = await new Promise<Buffer>((resolve, reject) => {
          const byteArray: any[] = []
          stream.on('data', (chunk) => {
            byteArray.push(chunk)
          })
          stream.on('end', () => {
            resolve(Buffer.concat(byteArray))
          })
          stream.on('error', reject)
        })
        storage.set(objectName, buffer)
      },
      async download(objectName) {
        return Readable.from(storage.get(objectName) ?? Buffer.from(''))
      },
      async delete(names) {
        for (const name of names) storage.delete(name)
      },
    }
  },
})
