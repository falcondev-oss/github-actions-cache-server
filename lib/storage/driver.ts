import { formatZodError } from '~/lib/env'
import { logger } from '~/lib/logger'
import type { StorageDriver } from '~/lib/types'

import type { z } from 'zod'

export function encodeCacheKey(key: string, version: string) {
  return encodeURIComponent(`${key}-${version}`)
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
      process.exit(1)
    }

    // eslint-disable-next-line ts/no-unsafe-argument
    const driver = options.setup(env.data)
    return driver instanceof Promise ? driver : Promise.resolve(driver)
  }
}
