import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'
import { ENV } from '~/lib/env'

import { defineStorageDriver } from '~/lib/storage/defineStorageDriver'

export const filesystemDriver = defineStorageDriver({
  envSchema: z.object({
    STORAGE_FILESYSTEM_PATH: z.string().default('.data/storage/filesystem'),
  }),
  async setup({ STORAGE_FILESYSTEM_PATH }) {
    const basePath = STORAGE_FILESYSTEM_PATH

    await fs.mkdir(basePath, {
      recursive: true,
    })

    const tempDir = await fs.mkdtemp(path.join(ENV.TEMP_DIR, 'github-actions-cache-server'))

    function getUploadBufferPath(uploadId: string) {
      return path.join(tempDir, uploadId)
    }

    function getStoragePath(objectName: string) {
      return path.join(basePath, objectName)
    }

    return {
      async initiateMultiPartUpload() {
        const uploadId = crypto.randomUUID()
        const tempPath = getUploadBufferPath(uploadId)
        await fs.mkdir(path.dirname(tempPath), { recursive: true })
        await fs.writeFile(tempPath, '')
        return uploadId
      },

      async uploadPart({ uploadId, chunkStart, data }) {
        const file = await fs.open(getUploadBufferPath(uploadId), 'r+')
        let currentChunk = 0
        const bufferWriteStream = new WritableStream<Buffer>({
          async write(chunk) {
            const start = chunkStart + currentChunk
            currentChunk += chunk.length
            await file.write(chunk, 0, chunk.length, start)
          },
        })
        await data.pipeTo(bufferWriteStream)
        await file.close()

        return {
          eTag: null,
        }
      },

      async completeMultipartUpload({ uploadId, objectName }) {
        const bufferPath = getUploadBufferPath(uploadId)
        await fs.copyFile(bufferPath, getStoragePath(objectName))
        await fs.rm(bufferPath)
      },

      async abortMultipartUpload({ uploadId }): Promise<void> {
        await fs.rm(getUploadBufferPath(uploadId), { force: true })
      },
      async download({ objectName }) {
        const stream = createReadStream(getStoragePath(objectName))
        return stream
      },
      async delete({ objectNames }) {
        for (const name of objectNames) {
          await fs.rm(getStoragePath(name), {
            force: true,
          })
        }
      },
    }
  },
})
