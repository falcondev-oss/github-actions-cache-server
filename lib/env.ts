import type { envDbDriverSchema, envStorageDriverSchema } from './schemas'
import arkenv from 'arkenv'
import { envSchema, envSchemaValidated } from './schemas'

// arkenv drops arktype's object morphs on a narrowed root (see `envSchemaValidated`),
// so re-apply them by running its output through `envSchema.assert`.
export const env = envSchema.assert(
  arkenv(envSchemaValidated, {
    env: Object.assign(
      {
        STORAGE_DRIVER: 'filesystem',
        STORAGE_FILESYSTEM_PATH: '.data/storage/filesystem',
        DB_DRIVER: 'sqlite',
        DB_SQLITE_PATH: '.data/sqlite.db',
      } satisfies typeof envStorageDriverSchema.infer & typeof envDbDriverSchema.infer,
      process.env,
    ),
  }),
)
