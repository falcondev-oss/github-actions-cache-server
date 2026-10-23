// Keeps the app version (Cargo.toml, Cargo.lock) and the Helm chart metadata in sync for releases.
import fs from 'node:fs/promises'
import path from 'node:path'

const chartPath = path.join('install', 'kubernetes', 'github-actions-cache-server', 'Chart.yaml')
const packageName = 'github-actions-cache-server'
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][\da-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*))*))?(?:\+([\da-z-]+(?:\.[\da-z-]+)*))?$/i
const cargoVersionPattern = /^(\[package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"]+)(")/m
const lockVersionPattern = new RegExp(`^(name = "${packageName}"\\nversion = ")([^"]+)(")`, 'm')

function fail(message) {
  throw new Error(`Release metadata error: ${message}`)
}

function readChartField(chart, field) {
  const match = chart.match(new RegExp(`^${field}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, 'm'))
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
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function bumpVersion(version, bump, label) {
  const { major, minor, patch } = parseSemver(version, label)
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    default:
      fail(`${label} bump must be one of patch, minor, or major, received "${bump ?? ''}"`)
  }
}

async function readMetadata() {
  const cargo = await fs.readFile('Cargo.toml', 'utf8')
  const appVersion = cargo.match(cargoVersionPattern)?.[2]
  if (!appVersion) fail('Cargo.toml must contain a [package] version')
  const chart = await fs.readFile(chartPath, 'utf8')
  return {
    cargo,
    appVersion,
    chart,
    chartVersion: readChartField(chart, 'version'),
    chartAppVersion: readChartField(chart, 'appVersion'),
  }
}

async function bump(appBump, chartBump) {
  const metadata = await readMetadata()
  const appVersion = bumpVersion(metadata.appVersion, appBump, 'app version')
  const chartVersion = bumpVersion(metadata.chartVersion, chartBump, 'chart version')

  await fs.writeFile('Cargo.toml', metadata.cargo.replace(cargoVersionPattern, `$1${appVersion}$3`))
  const lock = await fs.readFile('Cargo.lock', 'utf8')
  if (!lockVersionPattern.test(lock)) fail(`Cargo.lock must contain the ${packageName} package`)
  await fs.writeFile('Cargo.lock', lock.replace(lockVersionPattern, `$1${appVersion}$3`))
  await fs.writeFile(
    chartPath,
    replaceChartField(
      replaceChartField(metadata.chart, 'version', chartVersion),
      'appVersion',
      appVersion,
      true,
    ),
  )
  console.log(appVersion)
}

async function validate(tag) {
  if (!tag?.startsWith('v')) fail(`release tag must start with "v", received "${tag ?? ''}"`)

  const tagVersion = tag.slice(1)
  parseSemver(tagVersion, 'release tag version')
  const metadata = await readMetadata()
  parseSemver(metadata.appVersion, 'app version')
  parseSemver(metadata.chartVersion, 'chart version')

  if (tagVersion !== metadata.appVersion || tagVersion !== metadata.chartAppVersion) {
    fail(
      `release tag ${tag} must match app version and chart appVersion; received ${metadata.appVersion} and ${metadata.chartAppVersion}`,
    )
  }

  console.log(
    `Validated ${tag}: app version and chart appVersion are ${tagVersion}; chart version is ${metadata.chartVersion}`,
  )
}

const [command, ...args] = process.argv.slice(2)

try {
  if (command === 'bump') await bump(args[0], args[1])
  else if (command === 'validate') await validate(args[0])
  else fail(`expected command "bump" or "validate", received "${command ?? ''}"`)
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
}
