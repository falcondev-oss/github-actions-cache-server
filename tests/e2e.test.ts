import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { restoreCache, saveCache } from '@actions/cache'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { TEST_TEMP_DIR } from './setup'

const testFilePath = path.join(TEST_TEMP_DIR, 'test.bin')

const MB = 1024 * 1024

describe(`save and restore cache with @actions/cache package`, () => {
  beforeAll(async () => {
    process.env.ACTIONS_CACHE_SERVICE_V2 = 'true'
    process.env.ACTIONS_RUNTIME_TOKEN = await new SignJWT({
      ac: JSON.stringify([{ Scope: 'refs/heads/main', Permission: 3 }]),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(crypto.createSecretKey('mock-secret-key', 'ascii'))
  })
  afterAll(() => {
    delete process.env.ACTIONS_CACHE_SERVICE_V2
    delete process.env.ACTIONS_RUNTIME_TOKEN
  })

  for (const size of [1, 2 * MB, 64 * MB, 128 * MB, 512 * MB])
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
