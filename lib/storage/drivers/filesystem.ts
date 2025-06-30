import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { z } from 'zod'

import { parseEnv, StorageDriver } from '~/lib/storage/defineStorageDriver'
import { createTempDir } from '~/lib/utils'

export class FilesystemStorageDriver extends StorageDriver {
  constructor(baseFolderPrefix?: string) {
    super(baseFolderPrefix)
  }

  static async create() {
    const options = parseEnv(
      z.object({
        STORAGE_FILESYSTEM_PATH: z.string().default('.data/storage/filesystem'),
      }),
    )

    const baseFolderPrefix = options.STORAGE_FILESYSTEM_PATH
    await fs.mkdir(path.join(baseFolderPrefix, StorageDriver.baseFolder), {
      recursive: true,
    })
    await fs.mkdir(
      path.join(baseFolderPrefix, StorageDriver.baseFolder, StorageDriver.uploadFolder),
      {
        recursive: true,
      },
    )

    return new FilesystemStorageDriver(baseFolderPrefix)
  }

  async uploadPart(opts: { uploadId: string; partNumber: number; data: ReadableStream }) {
    const folderPath = this.getUploadFolderPrefix(opts.uploadId)
    await fs.mkdir(folderPath, { recursive: true })
    const writeStream = await createWriteStream(
      this.getUploadPartObjectName({
        uploadId: opts.uploadId,
        partNumber: opts.partNumber,
      }),
    )

    await pipeline(opts.data, writeStream)
  }

  async completeMultipartUpload(opts: {
    finalOutputObjectName: string
    uploadId: string
    partNumbers: number[]
  }) {
    const tempDir = await createTempDir()
    const outputTempFilePath = path.join(tempDir, 'output')

    for (const partNumber of opts.partNumbers) {
      const buffer = await fs.readFile(
        this.getUploadPartObjectName({
          uploadId: opts.uploadId,
          partNumber,
        }),
      )

      await fs.appendFile(outputTempFilePath, buffer)
    }

    await fs.copyFile(outputTempFilePath, this.addBaseFolderPrefix(opts.finalOutputObjectName))
    await fs.rm(outputTempFilePath)

    await Promise.all([
      this.cleanupMultipartUpload(opts.uploadId),
      fs.rm(outputTempFilePath, { force: true }),
    ])
  }

  async cleanupMultipartUpload(uploadId: string) {
    await fs.rm(this.getUploadFolderPrefix(uploadId), {
      force: true,
      recursive: true,
    })
  }

  async delete(objectNames: string[]): Promise<void> {
    for (const name of objectNames) {
      await fs.rm(this.addBaseFolderPrefix(name), {
        force: true,
      })
    }
  }

  async createReadStream(objectName: string) {
    return createReadStream(this.addBaseFolderPrefix(objectName))
  }

  createDownloadUrl: undefined
}
