import { beforeEach, describe, expect, test } from 'vitest'

import { findKeyMatch, pruneKeys, touchKey } from '@/lib/db'
import { sleep } from '@/tests/utils'

describe('key matching', () => {
  beforeEach(() => pruneKeys())

  const version = '0577ec58bee6d5415625'
  test('exact primary match', async () => {
    await touchKey('cache-a', version)

    const match = await findKeyMatch({
      key: 'cache-a',
      version,
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('cache-a')
    expect(match!.version).toBe(version)
  })
  test('exact restore key match', async () => {
    await touchKey('cache-a', version)

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
    await touchKey('prefixed-cache-a', version)

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
    await touchKey('cache-a', version)
    await touchKey('cache-b', version)

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
    await touchKey('prefixed-cache-a', version)
    await sleep(10)
    await touchKey('prefixed-cache-b', version)

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
    await touchKey('prefixed-cache', version)
    await sleep(10)
    await touchKey('prefixed-cache-a', version)

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
