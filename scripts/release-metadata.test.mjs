// Run with `node --test scripts/*.test.mjs`.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const scriptPath = path.resolve(import.meta.dirname, 'release-metadata.mjs')
const chartPath = 'install/kubernetes/github-actions-cache-server/Chart.yaml'
const directories = []

async function fixture(appVersion, chartVersion, chartAppVersion) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'release-metadata-'))
  directories.push(directory)
  await fs.mkdir(path.join(directory, path.dirname(chartPath)), { recursive: true })
  await fs.writeFile(
    path.join(directory, 'Cargo.toml'),
    `[package]\nname = "github-actions-cache-server"\nversion = "${appVersion}"\n\n[dependencies]\nfoo = { version = "1.0.0" }\n`,
  )
  await fs.writeFile(
    path.join(directory, 'Cargo.lock'),
    `[[package]]\nname = "foo"\nversion = "1.0.0"\n\n[[package]]\nname = "github-actions-cache-server"\nversion = "${appVersion}"\n`,
  )
  await fs.writeFile(
    path.join(directory, chartPath),
    `apiVersion: v2\nversion: ${chartVersion}\nappVersion: '${chartAppVersion}'\n`,
  )
  return directory
}

function read(directory, file) {
  return fs.readFile(path.join(directory, file), 'utf8')
}

async function fails(cwd, ...args) {
  const error = await run('node', [scriptPath, ...args], { cwd }).then(
    () => assert.fail('expected the command to fail'),
    (err) => err,
  )
  assert.equal(error.code, 1)
  return error.stderr
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true })))
})

describe('release metadata CLI', () => {
  test('bumps the app and chart versions and syncs appVersion', async () => {
    const cwd = await fixture('9.4.8', '1.0.3', '9.4.8')

    const { stdout } = await run('node', [scriptPath, 'bump', 'minor', 'patch'], { cwd })

    assert.equal(stdout.trim(), '9.5.0')
    assert.match(await read(cwd, 'Cargo.toml'), /^version = "9\.5\.0"$/m)
    assert.match(await read(cwd, 'Cargo.toml'), /foo = \{ version = "1\.0\.0" \}/)
    assert.match(await read(cwd, 'Cargo.lock'), /name = "foo"\nversion = "1\.0\.0"/)
    assert.match(
      await read(cwd, 'Cargo.lock'),
      /name = "github-actions-cache-server"\nversion = "9\.5\.0"/,
    )
    assert.equal(await read(cwd, chartPath), "apiVersion: v2\nversion: 1.0.4\nappVersion: '9.5.0'\n")
  })

  for (const [bump, expected] of [
    ['major', '2.0.0'],
    ['minor', '1.1.0'],
  ]) {
    test(`supports a ${bump} chart version bump`, async () => {
      const cwd = await fixture('9.4.8', '1.0.3', '9.4.8')
      await run('node', [scriptPath, 'bump', 'patch', bump], { cwd })
      assert.match(await read(cwd, chartPath), new RegExp(`^version: ${expected}$`, 'm'))
    })
  }

  test('rejects an unknown bump', async () => {
    const cwd = await fixture('9.4.8', '1.0.3', '9.4.8')
    assert.match(await fails(cwd, 'bump', 'huge', 'patch'), /app version bump must be one of/)
  })

  test('accepts consistent release metadata', async () => {
    const cwd = await fixture('9.4.8', '1.0.4', '9.4.8')

    const { stdout } = await run('node', [scriptPath, 'validate', 'v9.4.8'], { cwd })

    assert.match(
      stdout,
      /Validated v9\.4\.8: app version and chart appVersion are 9\.4\.8; chart version is 1\.0\.4/,
    )
  })

  test('rejects a tag that does not match the committed metadata', async () => {
    const cwd = await fixture('9.4.8', '1.0.4', '9.4.7')
    assert.match(
      await fails(cwd, 'validate', 'v9.4.8'),
      /release tag v9\.4\.8 must match app version and chart appVersion; received 9\.4\.8 and 9\.4\.7/,
    )
  })

  test('rejects an invalid chart version', async () => {
    const cwd = await fixture('9.4.8', 'latest', '9.4.8')
    assert.match(
      await fails(cwd, 'validate', 'v9.4.8'),
      /chart version must be valid SemVer, received "latest"/,
    )
  })
})
