/* eslint-disable unicorn/no-top-level-assignment-in-function */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { execa } from 'execa'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { TEST_TEMP_DIR } from './setup'

// Reproduction for issue #164: sccache uses opendal's ghac client, which speaks
// the protobuf variant of the Twirp CacheService API. Before the protobuf fix,
// sccache crashed on startup with a 400 ("Server startup failed: cache storage
// failed to read"). This test drives the real sccache binary against the server.
//
// Note: sccache selects the v2 (Twirp) API only when ACTIONS_CACHE_SERVICE_V2 is
// set; otherwise opendal falls back to the legacy /_apis/artifactcache REST API.
const SCCACHE_VERSION = 'v0.16.0'
const TARGETS: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

const workDir = path.join(TEST_TEMP_DIR, 'sccache')
let sccacheBin: string | undefined
let haveCc = false
let token: string

function sccacheEnv() {
  return {
    ...process.env,
    SCCACHE_GHA_ENABLED: 'on',
    ACTIONS_CACHE_SERVICE_V2: 'true',
    ACTIONS_RESULTS_URL: 'http://localhost:3000/',
    ACTIONS_CACHE_URL: 'http://localhost:3000/',
    ACTIONS_RUNTIME_TOKEN: token,
    SCCACHE_SERVER_PORT: '4229',
    SCCACHE_DIR: path.join(workDir, 'cache'),
  }
}

beforeAll(async () => {
  token = await new SignJWT({
    ac: JSON.stringify([{ Scope: 'refs/heads/main', Permission: 3 }]),
    repository_id: '123',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(crypto.createSecretKey('mock-secret-key', 'ascii'))

  haveCc = await execa('cc', ['--version'])
    .then(() => true)
    .catch(() => false)

  const target = TARGETS[`${process.platform}-${process.arch}`]
  if (!target) return

  // Download the prebuilt sccache release; skip the test if it can't be fetched.
  try {
    await fs.mkdir(workDir, { recursive: true })
    const url = `https://github.com/mozilla/sccache/releases/download/${SCCACHE_VERSION}/sccache-${SCCACHE_VERSION}-${target}.tar.gz`
    const res = await fetch(url)
    if (!res.ok) return

    const tarPath = path.join(workDir, 'sccache.tar.gz')
    await fs.writeFile(tarPath, Buffer.from(await res.arrayBuffer()))
    await execa('tar', ['-xzf', tarPath, '-C', workDir])

    const bin = path.join(workDir, `sccache-${SCCACHE_VERSION}-${target}`, 'sccache')
    await fs.chmod(bin, 0o755)
    sccacheBin = bin
  } catch {
    // network/extraction failure → test self-skips
  }
}, 120_000)

afterAll(async () => {
  if (sccacheBin) await execa(sccacheBin, ['--stop-server'], { env: sccacheEnv(), reject: false })
})

test('sccache starts and reads through the protobuf Twirp API (#164)', async (ctx) => {
  if (!sccacheBin || !haveCc) ctx.skip()
  const env = sccacheEnv()

  await execa(sccacheBin!, ['--stop-server'], { env, reject: false })

  // Before the fix this failed with "Server startup failed: cache storage failed
  // to read" — the startup probe hits the protobuf GetCacheEntryDownloadURL.
  const start = await execa(sccacheBin!, ['--start-server'], { env, reject: false })
  expect(start.exitCode).toBe(0)

  const src = path.join(workDir, 'probe.c')
  await fs.writeFile(src, 'int main(void){return 0;}\n')
  const compile = await execa(sccacheBin!, ['cc', '-c', src, '-o', path.join(workDir, 'probe.o')], {
    env,
    reject: false,
  })
  expect(compile.exitCode).toBe(0)

  const { stdout } = await execa(sccacheBin!, ['--show-stats', '--stats-format=json'], { env })
  const stats = JSON.parse(stdout).stats as {
    cache_read_errors: number
    cache_misses: { counts: Record<string, number> }
  }

  // The protobuf read path is exercised and healthy: no read errors, and the
  // compile produced a clean cache miss (GetCacheEntryDownloadURL → ok:false).
  expect(stats.cache_read_errors).toBe(0)
  const misses = Object.values(stats.cache_misses.counts ?? {}).reduce((a, b) => a + b, 0)
  expect(misses).toBeGreaterThan(0)
})
