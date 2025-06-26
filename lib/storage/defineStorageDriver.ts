/* eslint-disable unicorn/filename-case */

import type { Readable } from 'node:stream'
import type { z } from 'zod'

import { formatZodError } from '~/lib/env'
import { logger } from '~/lib/logger'

interface PartDetails {
  partNumber: number
  eTag?: string
}

export interface StorageDriver {
  initiateMultiPartUpload: (opts: { objectName: string; totalSize: number }) => Promise<string>
  uploadPart: (opts: {
    objectName: string
    uploadId: string
    partNumber: number
    data: ReadableStream
    chunkStart: number
  }) => Promise<{
    eTag: string | null
  }>
  completeMultipartUpload: (opts: {
    objectName: string
    uploadId: string
    parts: PartDetails[]
  }) => Promise<void>
  abortMultipartUpload: (opts: { objectName: string; uploadId: string }) => Promise<void>
  download: (opts: { objectName: string }) => Promise<ReadableStream | Readable>
  createDownloadUrl?: (opts: { objectName: string }) => Promise<string>
  delete: (opts: { objectNames: string[] }) => Promise<void>
}

interface DefineStorageDriverOptions<EnvSchema extends z.ZodTypeAny> {
  envSchema: EnvSchema
  setup: (options: z.output<EnvSchema>) => Promise<StorageDriver> | StorageDriver
}
export function defineStorageDriver<EnvSchema extends z.ZodTypeAny>(
  options: DefineStorageDriverOptions<EnvSchema>,
) {
  return () => {
    const env = options.envSchema.safeParse(process.env)
    if (!env.success) {
      logger.error(`Invalid environment variables:\n${formatZodError(env.error)}`)
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(1)
    }

    const driver = options.setup(env.data)
    return driver instanceof Promise ? driver : Promise.resolve(driver)
  }
}
