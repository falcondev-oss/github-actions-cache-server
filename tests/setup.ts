/* eslint-disable no-shadow */
import type { ResultPromise } from 'execa'

import type { Nitro } from 'nitropack'
import type { StartedTestContainer } from 'testcontainers'
import type { Env, envBaseSchema, envDbDriverSchema, envStorageDriverSchema } from '~/lib/schemas'

import fs from 'node:fs/promises'
import path from 'node:path'

import { MySqlContainer } from '@testcontainers/mysql'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { createEnv } from 'arkenv'
import { execa } from 'execa'
import { build, createNitro, prepare } from 'nitropack'
import { GenericContainer } from 'testcontainers'
import { match } from 'ts-pattern'
import { envSchema } from '~/lib/schemas'

export const TEST_TEMP_DIR = 'tests/temp'

const env = createEnv({
  VITEST_DB_DRIVER: envSchema.get('DB_DRIVER').default('sqlite'),
  VITEST_STORAGE_DRIVER: envSchema.get('STORAGE_DRIVER').default('filesystem'),
})

const TESTING_ENV_BASE = {
  API_BASE_URL: 'http://localhost:3000',
  RUNNER_TEMP: path.join(TEST_TEMP_DIR, 'runner-temp'),
  ACTIONS_RESULTS_URL: 'http://localhost:3000/',
  ACTIONS_CACHE_URL: 'http://localhost:3000/',
  METRICS_ENABLED: 'false',
} satisfies Omit<
  typeof envBaseSchema.infer,
  'CACHE_CLEANUP_OLDER_THAN_DAYS' | 'ENABLE_DIRECT_DOWNLOADS' | 'BENCHMARK' | 'METRICS_ENABLED'
> &
  Record<string, string>

const TESTING_ENV_BY_DB_DRIVER = {
  mysql: {
    DB_DRIVER: 'mysql',
    DB_MYSQL_DATABASE: 'vitest',
    DB_MYSQL_HOST: 'localhost',
    DB_MYSQL_PASSWORD: 'root',
    DB_MYSQL_PORT: 3306,
    DB_MYSQL_USER: 'root',
  },
  postgres: {
    DB_DRIVER: 'postgres',
    DB_POSTGRES_HOST: 'localhost',
    DB_POSTGRES_PORT: 5432,
    DB_POSTGRES_DATABASE: 'vitest',
    DB_POSTGRES_USER: 'postgres',
    DB_POSTGRES_PASSWORD: 'postgres',
  },
  sqlite: {
    DB_DRIVER: 'sqlite',
    DB_SQLITE_PATH: `${TEST_TEMP_DIR}/vitest.sqlite`,
  },
} satisfies {
  [K in Env['DB_DRIVER']]: Extract<(typeof envDbDriverSchema)['infer'], { DB_DRIVER: K }>
}

const TESTING_ENV_BY_STORAGE_DRIVER = {
  filesystem: {
    STORAGE_DRIVER: 'filesystem',
    STORAGE_FILESYSTEM_PATH: `${TEST_TEMP_DIR}/storage-filesystem`,
  },
  s3: {
    STORAGE_DRIVER: 's3',
    AWS_REGION: 'us-east-1',
    STORAGE_S3_BUCKET: 'vitest',
    AWS_ACCESS_KEY_ID: 'minioadmin',
    AWS_SECRET_ACCESS_KEY: 'minioadmin',
    AWS_ENDPOINT_URL: 'http://localhost:9000',
  },
  gcs: {
    STORAGE_DRIVER: 'gcs',
    STORAGE_GCS_BUCKET: 'vitest',
    STORAGE_GCS_ENDPOINT: 'http://localhost:9000',
    STORAGE_GCS_SERVICE_ACCOUNT_KEY: 'tests/gcs-service-account-key.json',
  },
} satisfies {
  [K in Env['STORAGE_DRIVER']]: Extract<
    (typeof envStorageDriverSchema)['infer'],
    { STORAGE_DRIVER: K }
  >
}

let nitro: Nitro
let server: ResultPromise<{
  node: true
  stdio: 'inherit'
}>
const testContainers: (StartedTestContainer | undefined)[] = []
export async function setup() {
  Object.assign(
    process.env,
    TESTING_ENV_BASE,
    TESTING_ENV_BY_DB_DRIVER[env.VITEST_DB_DRIVER],
    TESTING_ENV_BY_STORAGE_DRIVER[env.VITEST_STORAGE_DRIVER],
  )

  await fs.rm(TEST_TEMP_DIR, {
    force: true,
    recursive: true,
  })
  await fs.mkdir(TEST_TEMP_DIR, { recursive: true })

  // eslint-disable-next-line no-console
  console.log('Starting test containers for', env.VITEST_DB_DRIVER, env.VITEST_STORAGE_DRIVER)

  // containers
  testContainers.push(
    await match(env.VITEST_DB_DRIVER)
      .with('mysql', () => {
        const env = TESTING_ENV_BY_DB_DRIVER.mysql

        return new MySqlContainer('mysql:latest')
          .withDatabase(env.DB_MYSQL_DATABASE)
          .withRootPassword(env.DB_MYSQL_PASSWORD)
          .withExposedPorts({
            container: 3306,
            host: env.DB_MYSQL_PORT,
          })
          .start()
      })
      .with('postgres', () => {
        const env = TESTING_ENV_BY_DB_DRIVER.postgres

        return new PostgreSqlContainer('postgres:latest')
          .withDatabase(env.DB_POSTGRES_DATABASE)
          .withPassword(env.DB_POSTGRES_PASSWORD)
          .withUsername(env.DB_POSTGRES_USER)
          .withExposedPorts({
            host: env.DB_POSTGRES_PORT,
            container: 5432,
          })
          .start()
      })
      .with('sqlite', () => undefined)
      .exhaustive(),

    await match(env.VITEST_STORAGE_DRIVER)
      .with('s3', async () => {
        const env = TESTING_ENV_BY_STORAGE_DRIVER.s3

        return new GenericContainer('quay.io/minio/minio:latest')
          .withEntrypoint(['sh'])
          .withCommand([
            `-c`,
            `mkdir -p /data/${env.STORAGE_S3_BUCKET} && /usr/bin/minio server /data`,
          ])
          .withExposedPorts({
            container: 9000,
            host: 9000,
          })
          .withHealthCheck({
            test: ['CMD-SHELL', 'curl --fail http://localhost:9000/minio/health/ready'],
            interval: 1000,
            retries: 30,
            startPeriod: 1000,
          })
          .start()
      })
      .with('gcs', async () => {
        const env = TESTING_ENV_BY_STORAGE_DRIVER.gcs
        return new GenericContainer('fsouza/fake-gcs-server:latest')
          .withEntrypoint(['sh'])
          .withCommand([
            `-c`,
            `mkdir -p /data/${env.STORAGE_GCS_BUCKET} && /bin/fake-gcs-server -scheme http -port 9000 -data /data`,
          ])
          .withExposedPorts({
            container: 9000,
            host: 9000,
          })
          .withHealthCheck({
            test: ['CMD-SHELL', 'curl --fail http://localhost:9000/storage/v1/b'],
            interval: 1000,
            retries: 30,
            startPeriod: 1000,
          })
          .start()
      })
      .with('filesystem', () => undefined)
      .exhaustive(),
  )

  // nitro
  nitro = await createNitro({
    dev: false,
    preset: 'node-server',
  })
  await prepare(nitro)
  await build(nitro)

  server = execa({ node: true, stdio: 'inherit' })`.output/server/index.mjs`
  server.on('exit', (code) => {
    if (code === 0) return
    console.error('Nitro server exited with code', code)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  })
  // eslint-disable-next-line unicorn/no-process-exit
  server.addListener('error', () => process.exit(1))
  await new Promise<void>((resolve) =>
    server.on('message', (message) => {
      if (message === 'nitro:ready') resolve()
    }),
  )
}

export async function teardown() {
  await fs.rm('tests/temp', { recursive: true })
  await server?.kill()
  await nitro?.close()
  await Promise.all(
    testContainers.map((container) => container?.stop({ remove: true, removeVolumes: true })),
  )
}
