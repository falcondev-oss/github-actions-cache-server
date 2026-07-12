import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { restoreCache, saveCache } from '@actions/cache'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { TEST_TEMP_DIR } from './setup'

const testFilePath = path.join(TEST_TEMP_DIR, 'metrics.bin')

async function scrape() {
  const res = await fetch('http://localhost:3000/metrics')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/plain')
  return res.text()
}

function readCounter(text: string, series: string) {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `))
  return line ? Number(line.slice(series.length + 1)) : 0
}

describe('prometheus metrics', () => {
  beforeAll(async () => {
    process.env.ACTIONS_CACHE_SERVICE_V2 = 'true'
    process.env.ACTIONS_RUNTIME_TOKEN = await new SignJWT({
      ac: JSON.stringify([{ Scope: 'refs/heads/main', Permission: 3 }]),
      repository_id: '123',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(crypto.createSecretKey('mock-secret-key', 'ascii'))
  })
  afterAll(() => {
    delete process.env.ACTIONS_CACHE_SERVICE_V2
    delete process.env.ACTIONS_RUNTIME_TOKEN
  })

  test('counts uploads, hits, misses and transferred bytes', async () => {
    const before = await scrape()
    // default process metrics are wired up
    expect(before).toContain('process_start_time_seconds')

    // upload
    await fs.writeFile(testFilePath, crypto.randomBytes(1024 * 1024))
    await saveCache([testFilePath], 'metrics-key')
    await fs.rm(testFilePath)

    // hit
    const hitKey = await restoreCache([testFilePath], 'metrics-key')
    expect(hitKey).toBe('metrics-key')
    await fs.rm(testFilePath)

    // miss
    const missKey = await restoreCache([testFilePath], `metrics-miss-${crypto.randomUUID()}`)
    expect(missKey).toBeUndefined()

    const after = await scrape()

    // Counters are shared with concurrent tests, so assert deltas, not equality.
    expect(readCounter(after, 'cache_uploads_total')).toBeGreaterThan(
      readCounter(before, 'cache_uploads_total'),
    )
    expect(readCounter(after, 'cache_requests_total{result="hit"}')).toBeGreaterThan(
      readCounter(before, 'cache_requests_total{result="hit"}'),
    )
    expect(readCounter(after, 'cache_requests_total{result="miss"}')).toBeGreaterThan(
      readCounter(before, 'cache_requests_total{result="miss"}'),
    )
  })
})
