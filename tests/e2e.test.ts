import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { Readable } from 'node:stream'
import { restoreCache, saveCache } from '@actions/cache'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { useStorageAdapter } from '~/lib/storage'
import { getCacheFileName } from '~/lib/utils'

const TEST_TEMP_DIR = path.join(import.meta.dirname, 'temp')
await fs.mkdir(TEST_TEMP_DIR, { recursive: true })
const testFilePath = path.join(TEST_TEMP_DIR, 'test.bin')

const MB = 1024 * 1024

const versions = ['v2', 'v1'] as const

for (const version of versions) {
  describe(`save and restore cache with @actions/cache package with api ${version}`, () => {
    beforeAll(() => {
      if (version !== 'v2') return

      process.env.ACTIONS_CACHE_SERVICE_V2 = 'true'
      process.env.ACTIONS_RUNTIME_TOKEN = 'mock-runtime-token'
    })
    afterAll(() => {
      delete process.env.ACTIONS_CACHE_SERVICE_V2
      delete process.env.ACTIONS_RUNTIME_TOKEN
    })

    for (const size of [1, 5 * MB, 50 * MB, 500 * MB, 1024 * MB])
      test(`${size} Bytes`, { timeout: 90_000 }, async () => {
        // save
        const expectedContents = crypto.randomBytes(size)
        await fs.writeFile(testFilePath, expectedContents)
        await saveCache([testFilePath], 'cache-key')
        await fs.rm(testFilePath)

        // restore
        const cacheHitKey = await restoreCache([testFilePath], 'cache-key')
        expect(cacheHitKey).toBe('cache-key')

        // check contents
        const restoredContents = await fs.readFile(testFilePath)
        expect(restoredContents.compare(expectedContents)).toBe(0)
      })
  })
}

test(
  'pruning cache',
  {
    timeout: 60_000,
  },
  async () => {
    const storage = await useStorageAdapter()

    const { cacheId } = await storage.reserveCache({
      key: 'cache-a',
      version: '1',
    })
    if (!cacheId) throw new Error('Failed to reserve cache')

    // random 100MB ReadableStream
    const stream = new ReadableStream<Buffer>({
      start(controller) {
        const chunkSize = 1024 * 1024 // 1MB
        for (let i = 0; i < 100; i++) {
          const chunk = Buffer.alloc(chunkSize)
          controller.enqueue(chunk)
        }
        controller.close()
      },
    })
    await storage.uploadChunk({
      uploadId: cacheId,
      chunkIndex: 0,
      chunkStart: 0,
      chunkStream: stream,
    })
    await storage.commitCache(cacheId)

    // exists
    expect(
      await storage.getCacheEntry({
        keys: ['cache-a'],
        version: '1',
      }),
    ).toStrictEqual({
      archiveLocation: expect.stringMatching(
        new RegExp(
          `http:\/\/localhost:3000\/download\/[^\/]+\/${getCacheFileName('cache-a', '1')}`,
        ),
      ),
      cacheKey: 'cache-a',
    })
    expect(
      await storage.driver.createReadStream(getCacheFileName('cache-a', '1')).catch(() => null),
    ).toBeInstanceOf(Readable)

    await storage.pruneCaches()

    // doesn't exist
    expect(
      await storage.getCacheEntry({
        keys: ['cache-a'],
        version: '1',
      }),
    ).toBeNull()
    expect(
      await storage.driver.createReadStream(getCacheFileName('cache-a', '1')).catch(() => null),
    ).toBe(null)
  },
)
