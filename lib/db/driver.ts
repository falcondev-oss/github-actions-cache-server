import { formatZodError } from '~/lib/env'

import type { Dialect } from 'kysely'
import type { z } from 'zod'

import { logger } from '@/lib/logger'

interface DefineDatabaseDriverOptions<EnvSchema extends z.ZodTypeAny> {
  envSchema: EnvSchema
  setup: (options: z.output<EnvSchema>) => Promise<Dialect> | Dialect
}
export function defineDatabaseDriver<EnvSchema extends z.ZodTypeAny>(
  options: DefineDatabaseDriverOptions<EnvSchema>,
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
