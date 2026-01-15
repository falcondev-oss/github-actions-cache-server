import type { envDbDriverSchema, envStorageDriverSchema } from './schemas'
import arkenv from 'arkenv'
import { envSchema } from './schemas'

export const env = arkenv(envSchema, {
  env: Object.assign({}, process.env, {
    STORAGE_DRIVER: 'filesystem',
    STORAGE_FILESYSTEM_PATH: '.data/storage/filesystem',
    DB_DRIVER: 'sqlite',
    DB_SQLITE_PATH: '.data/sqlite.db',
  } satisfies typeof envStorageDriverSchema.infer & typeof envDbDriverSchema.infer),
})
