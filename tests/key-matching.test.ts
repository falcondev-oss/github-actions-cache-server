import { beforeEach, describe, expect, test } from 'vitest'

import { findKeyMatch, initializeDatabase, pruneKeys, updateOrCreateKey } from '~/lib/db'
import { initializeStorageAdapter } from '~/lib/storage'
import { sleep } from '~/tests/utils'

describe('key matching', () => {
  beforeEach(async () => {
    await initializeStorageAdapter()
    await initializeDatabase()
    await pruneKeys()
  })

  const version = '0577ec58bee6d5415625'
  test('exact primary match', async () => {
    await updateOrCreateKey('cache-a', version)

    const match = await findKeyMatch({
      key: 'cache-a',
      version,
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('cache-a')
    expect(match!.version).toBe(version)
  })
  test('exact restore key match', async () => {
    await updateOrCreateKey('cache-a', version)

    const match = await findKeyMatch({
      key: 'cache-b',
      version,
      restoreKeys: ['cache-a'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('cache-a')
    expect(match!.version).toBe(version)
  })
  test('prefixed restore key match', async () => {
    await updateOrCreateKey('prefixed-cache-a', version)

    const match = await findKeyMatch({
      key: 'prefixed-cache-b',
      version,
      restoreKeys: ['prefixed-cache'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('prefixed-cache-a')
    expect(match!.version).toBe(version)
  })
  test('restore key match with multiple keys', async () => {
    await updateOrCreateKey('cache-a', version)
    await updateOrCreateKey('cache-b', version)

    const match = await findKeyMatch({
      key: 'cache-c',
      version,
      restoreKeys: ['cache-a', 'cache-b'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('cache-a')
    expect(match!.version).toBe(version)
  })
  test('prefixed restore key match with multiple keys returns newest key', async () => {
    await updateOrCreateKey('prefixed-cache-a', version)
    await sleep(10)
    await updateOrCreateKey('prefixed-cache-b', version)

    const match = await findKeyMatch({
      key: 'prefixed-cache-c',
      version,
      restoreKeys: ['prefixed-cache'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('prefixed-cache-b')
    expect(match!.version).toBe(version)
  })
  test('restore key prefers exact match over prefixed match', async () => {
    await updateOrCreateKey('prefixed-cache', version)
    await sleep(10)
    await updateOrCreateKey('prefixed-cache-a', version)

    const match = await findKeyMatch({
      key: 'prefixed-cache-b',
      version,
      restoreKeys: ['prefixed-cache'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('prefixed-cache')
    expect(match!.version).toBe(version)
  })
})
