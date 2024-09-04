import fs from 'node:fs/promises'

import { MySqlContainer } from '@testcontainers/mysql'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { configDotenv } from 'dotenv'
import { execa } from 'execa'
import { build, createNitro, prepare } from 'nitropack'
import { GenericContainer } from 'testcontainers'
import { match } from 'ts-pattern'

import type { DatabaseDriverName } from '~/db-drivers'
import type { StorageDriverName } from '~/storage-drivers'

import type { ResultPromise } from 'execa'
import type { Nitro } from 'nitropack'
import type { StartedTestContainer } from 'testcontainers'

let nitro: Nitro
let server: ResultPromise
const testContainers: (StartedTestContainer | undefined)[] = []
export async function setup() {
  // config
  const dbDriver = process.env.VITEST_DB_DRIVER as DatabaseDriverName | undefined
  const storageDriver = process.env.VITEST_STORAGE_DRIVER as StorageDriverName | undefined
  if (!dbDriver || !storageDriver) {
    throw new Error('VITEST_DB_DRIVER and VITEST_STORAGE_DRIVER must be set')
  }

  const result = configDotenv({
    path: [`tests/.env.base`, `tests/.env.${storageDriver}.storage`, `tests/.env.${dbDriver}.db`],
  })
  if (result.error) throw result.error

  await fs.rm('tests/temp', {
    force: true,
    recursive: true,
  })

  // eslint-disable-next-line no-console
  console.log('Starting test containers for', dbDriver, storageDriver)

  // containers
  testContainers.push(
    await match(dbDriver)
      .with('mysql', () =>
        new MySqlContainer()
          .withDatabase('mysql')
          .withRootPassword('root')
          .withExposedPorts({
            container: 3306,
            host: 3306,
          })
          .start(),
      )
      .with('postgres', () =>
        new PostgreSqlContainer()
          .withDatabase('postgres')
          .withPassword('postgres')
          .withUsername('postgres')
          .withExposedPorts({
            host: 5432,
            container: 5432,
          })
          .start(),
      )

      .with('sqlite', () => undefined)
      .exhaustive(),
    await match(storageDriver)
      .with('s3', async () => {
        const container = await new GenericContainer('quay.io/minio/minio:latest')
          .withEntrypoint(['sh'])
          .withCommand([`-c`, `mkdir -p /data/test && /usr/bin/minio server /data`])
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

        return container
      })

      .with('filesystem', () => undefined)

      .with('memory', () => undefined)
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
  await new Promise<void>((resolve) => {
    server.on('message', (message) => {
      if (message === 'nitro:ready') resolve()
    })
  })
}

export async function teardown() {
  await fs.rm('tests/temp', { recursive: true })
  await server?.kill()
  await nitro?.close()
  await Promise.all(testContainers.map((container) => container?.stop()))
}
