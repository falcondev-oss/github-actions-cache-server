import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { restoreCache, saveCache } from '@actions/cache'
import pLimit from 'p-limit'

const TEMP_DIR = './benchmark'

Object.assign(process.env, {
  RUNNER_TEMP: path.join(TEMP_DIR, 'runner_temp'),
  ACTIONS_RESULTS_URL: 'http://localhost:3000/',
  ACTIONS_CACHE_URL: 'http://localhost:3000/',
  ACTIONS_CACHE_SERVICE_V2: 'true',
  ACTIONS_RUNTIME_TOKEN: 'mock-runtime',
})

const CONCURRENCY = 20
const FILE_SIZE_MB = 500
const TOTAL_REQUESTS = 10

const MOCK_BUFFER = randomBytes(1024 * 1024 * FILE_SIZE_MB)

async function run(id: number) {
  const testFilePath = path.join(TEMP_DIR, `test-file-${id}.bin`)
  await fs.writeFile(testFilePath, MOCK_BUFFER)

  await saveCache([testFilePath], `key`)
  await restoreCache([testFilePath], `key`)
}

await fs.mkdir(TEMP_DIR, { recursive: true })

const limiter = pLimit(CONCURRENCY)

const start = Date.now()
await Promise.all(Array.from({ length: TOTAL_REQUESTS }, (_, i) => limiter(() => run(i))))
const duration = Date.now() - start

console.debug(`Completed ${TOTAL_REQUESTS} requests in ${duration}ms`)

await fs.rm(TEMP_DIR, { recursive: true, force: true })
