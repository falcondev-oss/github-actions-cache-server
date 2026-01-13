import { type } from 'arkenv'

export const envStorageDriverSchema = type.or(
  {
    'STORAGE_DRIVER': type.unit('s3'),
    'STORAGE_S3_BUCKET': 'string',
    'AWS_REGION?': 'string',
    'AWS_ENDPOINT_URL?': 'string.url',
    'AWS_ACCESS_KEY_ID?': 'string',
    'AWS_SECRET_ACCESS_KEY?': 'string',
  },
  {
    STORAGE_DRIVER: type.unit('filesystem'),
    STORAGE_FILESYSTEM_PATH: 'string',
  },
  {
    STORAGE_DRIVER: type.unit('gcs'),
    STORAGE_GCS_BUCKET: 'string',
    STORAGE_GCS_SERVICE_ACCOUNT_KEY: 'string',
    STORAGE_GCS_ENDPOINT: 'string.url',
  },
)
export const envDbDriverSchema = type.or(
  {
    DB_DRIVER: type.unit('postgres'),
    DB_POSTGRES_DATABASE: 'string',
    DB_POSTGRES_HOST: 'string.host',
    DB_POSTGRES_PORT: 'number.port',
    DB_POSTGRES_USER: 'string',
    DB_POSTGRES_PASSWORD: 'string',
  },
  {
    DB_DRIVER: type.unit('mysql'),
    DB_MYSQL_DATABASE: 'string',
    DB_MYSQL_HOST: 'string.host',
    DB_MYSQL_PORT: 'number.port',
    DB_MYSQL_USER: 'string',
    DB_MYSQL_PASSWORD: 'string',
  },
  {
    DB_DRIVER: type.unit('sqlite'),
    DB_SQLITE_PATH: 'string',
  },
)

export const envBaseSchema = type({
  'API_BASE_URL': 'string.url',
  'CACHE_CLEANUP_OLDER_THAN_DAYS': 'number',
  'DISABLE_CLEANUP_JOBS?': 'boolean',
  'DEBUG?': 'boolean',
})

export const envSchema = envBaseSchema.and(envStorageDriverSchema).and(envDbDriverSchema)
export type Env = typeof envSchema.infer
