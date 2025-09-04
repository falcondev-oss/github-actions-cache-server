import { tmpdir } from 'node:os'
import { prettifyError, z } from 'zod'

const portSchema = z.coerce.number().int().min(1).max(65_535)

const envSchema = z.object({
  ENABLE_DIRECT_DOWNLOADS: z.stringbool().default(false),
  CACHE_CLEANUP_OLDER_THAN_DAYS: z.coerce.number().int().min(0).default(90),
  CACHE_CLEANUP_CRON: z.string().default('0 0 * * *'),
  UPLOAD_CLEANUP_CRON: z.string().default('*/10 * * * *'),
  API_BASE_URL: z.string().url(),
  STORAGE_DRIVER: z.string().toLowerCase().default('filesystem'),
  DB_DRIVER: z.string().toLowerCase().default('sqlite'),
  DEBUG: z.stringbool().default(false),
  NITRO_PORT: portSchema.default(3000),
  TEMP_DIR: z.string().default(tmpdir()),
})

const parsedEnv = envSchema.safeParse(process.env)
if (!parsedEnv.success) {
  console.error(`Invalid environment variables:\n${formatZodError(parsedEnv.error)}`)
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1)
}

export const ENV = parsedEnv.data

export function formatZodError(error: z.ZodError<any>) {
  return prettifyError(error)
}
