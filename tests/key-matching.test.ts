import { beforeEach, describe, expect, test } from 'vitest'

import { findKeyMatch, pruneKeys, updateOrCreateKey, useDB } from '~/lib/db'
import { useStorageAdapter } from '~/lib/storage'
import { sleep } from '~/tests/utils'

describe('key matching', async () => {
  const db = await useDB()
  beforeEach(async () => {
    await useStorageAdapter()
    await useDB()
    await pruneKeys(db)
  })

  const version = '0577ec58bee6d5415625'
  test('exact primary match', async () => {
    await updateOrCreateKey(db, { key: 'cache-a', version })

    const match = await findKeyMatch(db, {
      key: 'cache-a',
      version,
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('cache-a')
    expect(match!.version).toBe(version)
  })
  test('exact restore key match', async () => {
    await updateOrCreateKey(db, { key: 'cache-a', version })

    const match = await findKeyMatch(db, {
      key: 'cache-b',
      version,
      restoreKeys: ['cache-a'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('cache-a')
    expect(match!.version).toBe(version)
  })
  test('prefixed restore key match', async () => {
    await updateOrCreateKey(db, { key: 'prefixed-cache-a', version })

    const match = await findKeyMatch(db, {
      key: 'prefixed-cache-b',
      version,
      restoreKeys: ['prefixed-cache'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('prefixed-cache-a')
    expect(match!.version).toBe(version)
  })
  test('restore key match with multiple keys', async () => {
    await updateOrCreateKey(db, { key: 'cache-a', version })
    await updateOrCreateKey(db, { key: 'cache-b', version })

    const match = await findKeyMatch(db, {
      key: 'cache-c',
      version,
      restoreKeys: ['cache-a', 'cache-b'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('cache-a')
    expect(match!.version).toBe(version)
  })
  test('prefixed restore key match with multiple keys returns newest key', async () => {
    await updateOrCreateKey(db, { key: 'prefixed-cache-a', version })
    await sleep(10)
    await updateOrCreateKey(db, { key: 'prefixed-cache-b', version })

    const match = await findKeyMatch(db, {
      key: 'prefixed-cache-c',
      version,
      restoreKeys: ['prefixed-cache'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('prefixed-cache-b')
    expect(match!.version).toBe(version)
  })
  test('restore key prefers exact match over prefixed match', async () => {
    await updateOrCreateKey(db, { key: 'prefixed-cache', version })
    await sleep(10)
    await updateOrCreateKey(db, { key: 'prefixed-cache-a', version })

    const match = await findKeyMatch(db, {
      key: 'prefixed-cache-b',
      version,
      restoreKeys: ['prefixed-cache'],
    })
    expect(match).toBeDefined()
    expect(match!.key).toBe('prefixed-cache')
    expect(match!.version).toBe(version)
  })
})
