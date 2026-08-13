/* eslint-disable unicorn/no-top-level-assignment-in-function */
import type { ResultPromise } from 'execa'

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { restoreCache, saveCache } from '@actions/cache'
import { execa } from 'execa'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { TEST_TEMP_DIR } from './setup'

// A second server booted from the same build with URL signing on, on its own
// port (the shared harness server stays signing-off). The only place the enabled
// verify-on-handler path runs end-to-end against the real `@actions/cache` client.
const SIGNED_PORT = 3101
const SIGNED_BASE_URL = `http://localhost:${SIGNED_PORT}`
const URL_SIGNING_SECRET = 'test-url-signing-secret-0123456789'

const MB = 1024 * 1024
const testFilePath = path.join(TEST_TEMP_DIR, 'url-signing-e2e.bin')

let signedServer: ResultPromise<{ node: true; stdio: 'inherit' }>

// @actions/cache reads these from the environment at call time. Point the client
// at the signed server for this file, then restore the originals so later suites
// keep hitting the harness server.
const savedClientEnv: Record<string, string | undefined> = {}
function setClientEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    savedClientEnv[key] = process.env[key]
    process.env[key] = value
  }
}
function restoreClientEnv() {
  for (const [key, value] of Object.entries(savedClientEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('signed cache URLs end-to-end (URL_SIGNING_ENABLED=true)', () => {
  beforeAll(async () => {
    signedServer = execa({
      node: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(SIGNED_PORT),
        NITRO_PORT: String(SIGNED_PORT),
        API_BASE_URL: SIGNED_BASE_URL,
        URL_SIGNING_ENABLED: 'true',
        URL_SIGNING_SECRET,
      },
    })`.output/server/index.mjs`
    signedServer.on('exit', (code) => {
      if (code === 0 || code === null) return
      console.error('Signed Nitro server exited with code', code)
    })
    await new Promise<void>((resolve, reject) => {
      signedServer.on('error', reject)
      signedServer.on('exit', (code) =>
        reject(new Error(`signed server exited before ready (code ${code})`)),
      )
      signedServer.on('message', (message) => {
        if (message === 'nitro:ready') resolve()
      })
    })

    setClientEnv({
      ACTIONS_RESULTS_URL: `${SIGNED_BASE_URL}/`,
      ACTIONS_CACHE_URL: `${SIGNED_BASE_URL}/`,
      ACTIONS_CACHE_SERVICE_V2: 'true',
      ACTIONS_RUNTIME_TOKEN: await new SignJWT({
        ac: JSON.stringify([{ Scope: 'refs/heads/main', Permission: 3 }]),
        repository_id: '123',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(crypto.createSecretKey('mock-secret-key', 'ascii')),
    })
  }, 60_000)

  afterAll(async () => {
    restoreClientEnv()
    await signedServer?.kill()
    await fs.rm(testFilePath, { force: true })
  })

  // 64MB forces a multi-block upload + blocklist commit, proving one signature
  // covers every block PUT and the finalize (i.e. the Azure SDK keeps the
  // `exp`/`sig` query params when it appends `blockid`/`comp`).
  test('saves and restores through signed upload/download URLs', { timeout: 90_000 }, async () => {
    const key = 'url-signing-e2e-key'
    const expectedContents = crypto.randomBytes(64 * MB)
    await fs.writeFile(testFilePath, expectedContents)

    await saveCache([testFilePath], key)
    await fs.rm(testFilePath)

    const cacheHitKey = await restoreCache([testFilePath], key)
    expect(cacheHitKey).toBe(key)

    const restoredContents = await fs.readFile(testFilePath)
    expect(restoredContents.compare(expectedContents)).toBe(0)
  })

  // Enforcement is actually on the handlers (not just minted into URLs): an
  // unsigned request to either proxied route is rejected with 401.
  test('rejects unsigned requests to the proxied routes with 401', async () => {
    const download = await fetch(`${SIGNED_BASE_URL}/download/does-not-matter`)
    expect(download.status).toBe(401)

    const upload = await fetch(`${SIGNED_BASE_URL}/devstoreaccount1/upload/1`, { method: 'PUT' })
    expect(upload.status).toBe(401)
  })
})
