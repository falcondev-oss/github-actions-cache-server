import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { execa } from 'execa'
import { afterEach, describe, expect, test } from 'vitest'

const scriptPath = path.resolve('scripts/release-metadata.mjs')
const temporaryDirectories: string[] = []

async function createReleaseMetadata(
  packageVersion: string,
  chartVersion: string,
  appVersion: string,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'release-metadata-'))
  temporaryDirectories.push(directory)

  await fs.mkdir(path.join(directory, 'install/kubernetes/github-actions-cache-server'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ version: packageVersion }, null, 2)}\n`,
  )
  await fs.writeFile(
    path.join(directory, 'install/kubernetes/github-actions-cache-server/Chart.yaml'),
    `apiVersion: v2\nversion: ${chartVersion}\nappVersion: '${appVersion}'\n`,
  )

  return directory
}

function readChart(directory: string) {
  return fs.readFile(
    path.join(directory, 'install/kubernetes/github-actions-cache-server/Chart.yaml'),
    'utf8',
  )
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  )
})

describe('release metadata CLI', () => {
  test('bumps chart patch version and synchronizes appVersion with the package version', async () => {
    const cwd = await createReleaseMetadata('9.4.8', '1.0.3', '9.4.7')

    await execa('node', [scriptPath, 'bump', 'patch'], { cwd })

    await expect(readChart(cwd)).resolves.toBe(
      "apiVersion: v2\nversion: 1.0.4\nappVersion: '9.4.8'\n",
    )
  })

  test.each([
    ['minor', '1.1.0'],
    ['major', '2.0.0'],
  ])('supports a %s chart version bump', async (bump, expectedVersion) => {
    const cwd = await createReleaseMetadata('9.4.8', '1.0.3', '9.4.7')

    await execa('node', [scriptPath, 'bump', bump], { cwd })

    await expect(readChart(cwd)).resolves.toContain(`version: ${expectedVersion}\n`)
  })

  test('accepts consistent release metadata with a valid chart version', async () => {
    const cwd = await createReleaseMetadata('9.4.8', '1.0.4', '9.4.8')

    const result = await execa('node', [scriptPath, 'validate', 'v9.4.8'], { cwd })

    expect(result.stdout).toContain(
      'Validated v9.4.8: package and appVersion are 9.4.8; chart version is 1.0.4',
    )
  })

  test('rejects a release tag that does not match committed application metadata', async () => {
    const cwd = await createReleaseMetadata('9.4.8', '1.0.4', '9.4.7')

    const result = await execa('node', [scriptPath, 'validate', 'v9.4.8'], {
      cwd,
      reject: false,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'release tag v9.4.8 must match package version and chart appVersion; received 9.4.8 and 9.4.7',
    )
  })

  test('rejects an invalid chart version before release', async () => {
    const cwd = await createReleaseMetadata('9.4.8', 'latest', '9.4.8')

    const result = await execa('node', [scriptPath, 'validate', 'v9.4.8'], {
      cwd,
      reject: false,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('chart version must be valid SemVer, received "latest"')
  })
})
