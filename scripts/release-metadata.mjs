import fs from 'node:fs/promises'
import path from 'node:path'

const chartPath = path.join('install', 'kubernetes', 'github-actions-cache-server', 'Chart.yaml')
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][\da-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*))*))?(?:\+([\da-z-]+(?:\.[\da-z-]+)*))?$/i

function fail(message) {
  throw new Error(`Release metadata error: ${message}`)
}

function readChartField(chart, field) {
  const match = chart.match(new RegExp(`^${field}:\\s*['\"]?([^'\"\\s]+)['\"]?\\s*$`, 'm'))
  if (!match) fail(`Chart.yaml must contain a single-line ${field} field`)
  return match[1]
}

function replaceChartField(chart, field, value, quoted = false) {
  return chart.replace(
    new RegExp(`^${field}:.*$`, 'm'),
    () => `${field}: ${quoted ? `'${value}'` : value}`,
  )
}

function parseSemver(version, label) {
  const match = version.match(semverPattern)
  if (!match) fail(`${label} must be valid SemVer, received "${version}"`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

async function readMetadata() {
  const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'))
  const chart = await fs.readFile(chartPath, 'utf8')
  return {
    packageVersion: packageJson.version,
    chart,
    chartVersion: readChartField(chart, 'version'),
    appVersion: readChartField(chart, 'appVersion'),
  }
}

async function bumpChartVersion(bump) {
  if (!['patch', 'minor', 'major', 'dev'].includes(bump)) {
    fail(`chart bump must be one of patch, minor, or major, received "${bump ?? ''}"`)
  }

  const metadata = await readMetadata()
  let { major, minor, patch } = parseSemver(metadata.chartVersion, 'chart version')

  switch (bump) {
    case 'major': {
      ;[major, minor, patch] = [major + 1, 0, 0]
      break
    }
    case 'minor': {
      ;[minor, patch] = [minor + 1, 0]
      break
    }
    case 'patch' || 'dev': {
      patch += 1
      break
    }
  }

  let chartVersion = `${major}.${minor}.${patch}`
  if (bump === 'dev') {
    chartVersion += '-dev'
  }
  const chart = replaceChartField(
    replaceChartField(metadata.chart, 'version', chartVersion),
    'appVersion',
    metadata.packageVersion,
    true,
  )
  await fs.writeFile(chartPath, chart)
  console.debug(
    `Updated chart version to ${chartVersion} and appVersion to ${metadata.packageVersion}`,
  )
}

async function validateReleaseMetadata(tag) {
  if (!tag?.startsWith('v')) fail(`release tag must start with "v", received "${tag ?? ''}"`)

  const tagVersion = tag.slice(1)
  parseSemver(tagVersion, 'release tag version')
  const metadata = await readMetadata()
  parseSemver(metadata.packageVersion, 'package version')
  parseSemver(metadata.chartVersion, 'chart version')

  if (tagVersion !== metadata.packageVersion || tagVersion !== metadata.appVersion) {
    fail(
      `release tag ${tag} must match package version and chart appVersion; received ${metadata.packageVersion} and ${metadata.appVersion}`,
    )
  }

  console.debug(
    `Validated ${tag}: package and appVersion are ${tagVersion}; chart version is ${metadata.chartVersion}`,
  )
}

const [command, argument] = process.argv.slice(2)

try {
  if (command === 'bump') await bumpChartVersion(argument)
  else if (command === 'validate') await validateReleaseMetadata(argument)
  else fail(`expected command "bump" or "validate", received "${command ?? ''}"`)
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
}
