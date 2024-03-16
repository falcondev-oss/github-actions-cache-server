import { z } from 'zod'

const envSchema = z.object({
  CACHE_SERVER_TOKEN: z.string().min(1),
  BASE_URL: z.string().min(1),
  DATA_DIR: z.string().min(1),
})

export const ENV = envSchema.parse(process.env)
