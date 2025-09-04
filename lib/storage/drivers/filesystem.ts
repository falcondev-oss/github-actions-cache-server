import type { StorageDriver } from '~/lib/storage/storage-driver'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'

import { pipeline } from 'node:stream/promises'

import { z } from 'zod'
import { BASE_FOLDER, parseEnv, UPLOAD_FOLDER } from '~/lib/storage/storage-driver'
import { createTempDir } from '~/lib/utils'

export const FilesystemStorageDriver = {
  async create() {
    const options = parseEnv(
      z.object({
        STORAGE_FILESYSTEM_PATH: z.string().default('.data/storage/filesystem'),
      }),
    )

    const rootFolder = options.STORAGE_FILESYSTEM_PATH
    await fs.mkdir(path.join(rootFolder, BASE_FOLDER), {
      recursive: true,
    })
    await fs.mkdir(path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER), {
      recursive: true,
    })

    return <StorageDriver>{
      async uploadPart(opts) {
        const folderPath = path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER, opts.uploadId)
        await fs.mkdir(folderPath, { recursive: true })
        const writeStream = await createWriteStream(
          path.join(folderPath, `part_${opts.partNumber}`),
        )
        await pipeline(opts.data, writeStream)
      },

      async completeMultipartUpload(opts) {
        const tempDir = await createTempDir()
        const outputTempFilePath = path.join(tempDir, 'output')

        for (const partNumber of opts.partNumbers) {
          const buffer = await fs.readFile(
            path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER, opts.uploadId, `part_${partNumber}`),
          )

          await fs.appendFile(outputTempFilePath, buffer)
        }

        await fs.copyFile(
          outputTempFilePath,
          path.join(rootFolder, BASE_FOLDER, opts.cacheFileName),
        )
        await fs.rm(outputTempFilePath)

        await Promise.all([
          this.cleanupMultipartUpload(opts.uploadId),
          fs.rm(outputTempFilePath, { force: true }),
        ])
      },

      async cleanupMultipartUpload(uploadId) {
        await fs.rm(path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER, uploadId), {
          force: true,
          recursive: true,
        })
      },

      async delete(cacheFileNames): Promise<void> {
        for (const cacheFileName of cacheFileNames) {
          await fs.rm(path.join(rootFolder, BASE_FOLDER, cacheFileName), {
            force: true,
          })
        }
      },

      async createReadStream(cacheFileName) {
        const filePath = path.join(rootFolder, BASE_FOLDER, cacheFileName)
        if (!(await fs.stat(filePath))) return null

        return createReadStream(filePath)
      },
    }
  },
}
