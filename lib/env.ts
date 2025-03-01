import { z } from 'zod'

const booleanSchema = z.string().transform((v) => v.toLowerCase() === 'true')

const envSchema = z.object({
  ENABLE_DIRECT_DOWNLOADS: booleanSchema.default('false'),
  CLEANUP_OLDER_THAN_DAYS: z.coerce.number().int().min(0).default(90),
  API_BASE_URL: z.string().url(),
  STORAGE_DRIVER: z.string().toLowerCase().default('filesystem'),
  DB_DRIVER: z.string().toLowerCase().default('sqlite'),
  DEBUG: booleanSchema.default('false'),
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
  return error.errors.map((e) => ` - ${e.path.join('.')}: ${e.message}`).join('\n')
}
