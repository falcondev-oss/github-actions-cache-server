import { z } from 'zod'

import { logger } from '@/lib/logger'

const envSchema = z.object({
  URL_ACCESS_TOKEN: z.string().min(1),
  BASE_URL: z.string().min(1),
  DATA_DIR: z.string().min(1),
})

const parsedEnv = envSchema.safeParse(process.env)
if (!parsedEnv.success) {
  logger.error(`Invalid environment variables:\n${formatZodError(parsedEnv.error)}`)
  process.exit(1)
}

export const ENV = parsedEnv.data

function formatZodError(error: z.ZodError<any>) {
  return error.errors.map((e) => ` - ${e.path.join('.')}: ${e.message}`).join('\n')
}
