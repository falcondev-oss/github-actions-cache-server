import type { StorageDriver } from '@/lib/types'
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
    // eslint-disable-next-line ts/no-unsafe-assignment
    const env = options.envSchema.parse(process.env)
    // eslint-disable-next-line ts/no-unsafe-argument
    const driver = options.setup(env)
    return driver instanceof Promise ? driver : Promise.resolve(driver)
  }
}
