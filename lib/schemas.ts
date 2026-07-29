import { type } from 'arkenv'

const envS3StorageDriverBaseSchema = {
  'STORAGE_DRIVER': type.unit('s3'),
  'STORAGE_S3_BUCKET': 'string',
  'STORAGE_S3_SOCKET_TIMEOUT_MS': 'number.integer >= 0 = 10000',
  'AWS_REGION': "string = 'us-east-1'",
  'AWS_ENDPOINT_URL?': 'string.url',
} as const

export const envStorageDriverSchema = type.or(
  {
    ...envS3StorageDriverBaseSchema,
    'AWS_ACCESS_KEY_ID': 'string',
    'AWS_SECRET_ACCESS_KEY': 'string',
    'AWS_ROLE_ARN?': 'undefined',
    'AWS_WEB_IDENTITY_TOKEN_FILE?': 'undefined',
    'AWS_ROLE_SESSION_NAME?': 'undefined',
  },
  {
    ...envS3StorageDriverBaseSchema,
    'AWS_ROLE_ARN': 'string',
    'AWS_WEB_IDENTITY_TOKEN_FILE': 'string',
    'AWS_ROLE_SESSION_NAME?': 'string',
    'AWS_ACCESS_KEY_ID?': 'undefined',
    'AWS_SECRET_ACCESS_KEY?': 'undefined',
  },
  {
    STORAGE_DRIVER: type.unit('filesystem'),
    STORAGE_FILESYSTEM_PATH: 'string',
  },
  {
    'STORAGE_DRIVER': type.unit('gcs'),
    'STORAGE_GCS_BUCKET': 'string',
    'STORAGE_GCS_SERVICE_ACCOUNT_KEY?': 'string',
    'STORAGE_GCS_ENDPOINT?': 'string.url',
  },
)
export const envDbDriverSchema = type.or(
  type.or(
    {
      'DB_DRIVER': type.unit('postgres'),
      'DB_POSTGRES_DATABASE': 'string',
      'DB_POSTGRES_HOST': 'string',
      'DB_POSTGRES_PORT': 'number.port',
      'DB_POSTGRES_USER': 'string',
      'DB_POSTGRES_PASSWORD': 'string',
      'DB_POSTGRES_URL?': 'undefined',
    },
    {
      'DB_DRIVER': type.unit('postgres'),
      'DB_POSTGRES_URL': 'string',
      'DB_POSTGRES_DATABASE?': 'undefined',
      'DB_POSTGRES_HOST?': 'undefined',
      'DB_POSTGRES_PORT?': 'undefined',
      'DB_POSTGRES_USER?': 'undefined',
      'DB_POSTGRES_PASSWORD?': 'undefined',
    },
  ),
  {
    DB_DRIVER: type.unit('mysql'),
    DB_MYSQL_DATABASE: 'string',
    DB_MYSQL_HOST: 'string',
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
  'API_BASE_URL': type('string.url').pipe((s) => s.replace(/\/+$/, '')),
  'DEFAULT_ACTIONS_RESULTS_URL':
    "string.url = 'https://results-receiver.actions.githubusercontent.com'",
  'ACTIONS_TOKEN_ISSUER': "string.url = 'https://token.actions.githubusercontent.com'",
  'ACTIONS_TOKEN_JWKS_URL?': 'string.url',
  'CACHE_CLEANUP_OLDER_THAN_DAYS': 'number = 90',
  'CACHE_MAX_SIZE_BYTES?': 'number.integer > 0',
  'CACHE_FILESYSTEM_MAX_USAGE_PERCENT': 'number > 0 & number <= 100 = 90',
  'ORPHANED_STORAGE_GRACE_PERIOD_HOURS': 'number.integer >= 1 = 24',
  'DISABLE_CLEANUP_JOBS?': 'boolean',
  'DEBUG?': 'unknown',
  'ENABLE_DIRECT_DOWNLOADS': 'boolean = false',
  'BENCHMARK': 'boolean = false',
  'SKIP_TOKEN_VALIDATION': 'boolean = false',
  'MANAGEMENT_API_KEY?': 'string',
})

export const envSchema = envBaseSchema.and(envStorageDriverSchema).and(envDbDriverSchema)
export type Env = typeof envSchema.infer
