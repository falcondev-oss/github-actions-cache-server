import { z } from 'zod'

const envSchema = z.object({
  ACTIONS_RUNTIME_TOKEN: z.string().min(1),
  BASE_URL: z.string().min(1),
  SECRET: z.string().min(1),
  MINIO_BUCKET: z.string().min(1),
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().positive(),
  MINIO_USE_SSL: z.string().transform((v) => v === 'true'),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
})

export const ENV = envSchema.parse(process.env)
