import { tmpdir } from 'node:os'
import { z } from 'zod'

const booleanSchema = z.string().transform((v) => v.toLowerCase() === 'true')
const portSchema = z.coerce.number().int().min(1).max(65_535)

const envSchema = z.object({
  ENABLE_DIRECT_DOWNLOADS: booleanSchema.default('false'),
  CACHE_CLEANUP_OLDER_THAN_DAYS: z.coerce.number().int().min(0).default(90),
  CACHE_CLEANUP_CRON: z.string().default('0 0 * * *'),
  UPLOAD_CLEANUP_CRON: z.string().default('*/10 * * * *'),
  API_BASE_URL: z.string().url(),
  STORAGE_DRIVER: z.string().toLowerCase().default('filesystem'),
  DB_DRIVER: z.string().toLowerCase().default('sqlite'),
  DEBUG: booleanSchema.default('false'),
  PROXY_PORT: portSchema.default(8000),
  NITRO_PORT: portSchema.default(3000),
  CA_KEY_PATH: z.string(),
  CA_CERT_PATH: z.string(),
  TEMP_DIR: z.string().default(tmpdir()),
  DISABLE_PROXY: booleanSchema.default('false'),
})

const parsedEnv = envSchema.safeParse(process.env)
if (!parsedEnv.success) {
  console.error(`Invalid environment variables:\n${formatZodError(parsedEnv.error)}`)
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1)
}

export const ENV = parsedEnv.data

export function formatZodError(error: z.ZodError<any>) {
  return error.errors.map((e) => ` - ${e.path.join('.')}: ${e.message}`).join('\n')
}
