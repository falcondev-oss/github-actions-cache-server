/* eslint-disable unicorn/filename-case */

import type { Readable } from 'node:stream'
import type { z } from 'zod'
import path from 'node:path'

import { formatZodError } from '~/lib/env'
import { logger } from '~/lib/logger'

export abstract class StorageDriver {
  static baseFolder = 'gh-actions-cache'
  static uploadFolder = '.uploads'
  baseFolderPrefix: string | undefined

  constructor(baseFolderPrefix?: string) {
    this.baseFolderPrefix = baseFolderPrefix
  }

  addBaseFolderPrefix(objectName: string) {
    return path.join(this.baseFolderPrefix ?? '', StorageDriver.baseFolder, objectName)
  }

  getUploadFolderPrefix(uploadId: string) {
    return path.join(
      this.baseFolderPrefix ?? '',
      StorageDriver.baseFolder,
      StorageDriver.uploadFolder,
      uploadId,
    )
  }

  addUploadFolderPrefix(opts: { uploadId: string; objectName: string }) {
    return path.join(this.getUploadFolderPrefix(opts.uploadId), opts.objectName)
  }

  getUploadPartObjectName(opts: { uploadId: string; partNumber: number }) {
    return this.addUploadFolderPrefix({
      uploadId: opts.uploadId,
      objectName: `part_${opts.partNumber}`,
    })
  }

  abstract delete(objectNames: string[]): Promise<void>
  abstract createReadStream(objectName: string): Promise<ReadableStream | Readable>
  abstract createDownloadUrl?(objectName: string): Promise<string>
  abstract uploadPart(opts: {
    uploadId: string
    partNumber: number
    data: ReadableStream
  }): Promise<void>
  abstract completeMultipartUpload(opts: {
    finalOutputObjectName: string
    uploadId: string
    partNumbers: number[]
  }): Promise<void>
  abstract cleanupMultipartUpload(uploadId: string): Promise<void>
}

export function parseEnv<Schema extends z.ZodTypeAny>(schema: Schema) {
  const env = schema.safeParse(process.env)
  if (!env.success) {
    logger.error(`Invalid environment variables:\n${formatZodError(env.error)}`)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  return env.data as z.output<Schema>
}
