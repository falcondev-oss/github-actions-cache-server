import { z } from 'zod'

import { logger } from '~/lib/logger'

const envSchema = z.object({
  URL_ACCESS_TOKEN: z.string().min(1),
  CLEANUP_OLDER_THAN_DAYS: z.coerce.number().int().min(0).default(90),
  API_BASE_URL: z.string().min(1),
  STORAGE_DRIVER: z.string().toLowerCase().default('filesystem'),
  DB_DRIVER: z.string().toLowerCase().default('sqlite'),
  TEMP_DIR: z.string().min(1).default('/tmp'),
})

const parsedEnv = envSchema.safeParse(process.env)
if (!parsedEnv.success) {
  logger.error(`Invalid environment variables:\n${formatZodError(parsedEnv.error)}`)
  process.exit(1)
}

export const ENV = parsedEnv.data

export function formatZodError(error: z.ZodError<any>) {
  return error.errors.map((e) => ` - ${e.path.join('.')}: ${e.message}`).join('\n')
}
