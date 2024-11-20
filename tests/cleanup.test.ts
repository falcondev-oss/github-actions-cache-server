import { beforeEach, describe, expect, test } from 'vitest'

import {
  findKeyMatch,
  findStaleKeys,
  initializeDatabase,
  pruneKeys,
  touchKey,
  updateOrCreateKey,
  useDB,
} from '~/lib/db'
import { initializeStorage } from '~/lib/storage'

describe('setting last accessed date', () => {
  beforeEach(async () => {
    await initializeStorage()
    await initializeDatabase()
    await pruneKeys(useDB())
  })

  const version = '0577ec58bee6d5415625'
  test('`updateOrCreateKey` sets accessed_at', async () => {
    const db = useDB()
    const date = new Date('2024-01-01T00:00:00Z')
    await updateOrCreateKey(db, { key: 'cache-a', version, date })

    const match = await findKeyMatch(db, {
      key: 'cache-a',
      version,
    })
    expect(match).toBeDefined()
    expect(match!.accessed_at).toBe('2024-01-01T00:00:00.000Z')
  })

  test('`touchKey` updates accessed_at', async () => {
    const db = useDB()
    const date = new Date('2024-01-01T00:00:00Z')
    await updateOrCreateKey(db, { key: 'cache-a', version, date })

    const match = await findKeyMatch(db, {
      key: 'cache-a',
      version,
    })
    expect(match).toBeDefined()
    expect(match!.accessed_at).toBe('2024-01-01T00:00:00.000Z')
    expect(match!.updated_at).toBe('2024-01-01T00:00:00.000Z')

    const newDate = new Date('2024-01-02T00:00:00Z')
    await touchKey(db, { key: 'cache-a', version, date: newDate })

    const newMatch = await findKeyMatch(db, {
      key: 'cache-a',
      version,
    })
    expect(newMatch).toBeDefined()
    expect(newMatch!.accessed_at).toBe('2024-01-02T00:00:00.000Z')
    expect(newMatch!.updated_at).toBe('2024-01-01T00:00:00.000Z')
  })
})

describe('getting stale keys', () => {
  beforeEach(() => pruneKeys(useDB()))

  const version = '0577ec58bee6d5415625'
  test('returns stale keys if threshold is passed', async () => {
    const db = useDB()
    const referenceDate = new Date('2024-04-01T00:00:00Z')
    await updateOrCreateKey(db, { key: 'cache-a', version, date: new Date('2024-01-01T00:00:00Z') })
    await updateOrCreateKey(db, { key: 'cache-b', version, date: new Date('2024-02-01T00:00:00Z') })
    await updateOrCreateKey(db, { key: 'cache-c', version, date: new Date('2024-03-15T00:00:00Z') })
    await updateOrCreateKey(db, { key: 'cache-d', version, date: new Date('2024-03-20T00:00:00Z') })

    const match = await findStaleKeys(db, { olderThanDays: 30, date: referenceDate })
    expect(match.length).toBe(2)

    const matchA = match.find((m) => m.key === 'cache-a')
    expect(matchA).toBeDefined()
    expect(matchA?.accessed_at).toBe('2024-01-01T00:00:00.000Z')

    const matchB = match.find((m) => m.key === 'cache-b')
    expect(matchB).toBeDefined()
    expect(matchB?.accessed_at).toBe('2024-02-01T00:00:00.000Z')
  })

  test('returns all keys if threshold is not passed', async () => {
    const db = useDB()
    const referenceDate = new Date('2024-04-01T00:00:00Z')
    await updateOrCreateKey(db, { key: 'cache-a', version, date: new Date('2024-01-01T00:00:00Z') })
    await updateOrCreateKey(db, { key: 'cache-b', version, date: new Date('2024-02-01T00:00:00Z') })
    await updateOrCreateKey(db, { key: 'cache-c', version, date: new Date('2024-03-15T00:00:00Z') })
    await updateOrCreateKey(db, { key: 'cache-d', version, date: new Date('2024-04-01T00:00:00Z') })

    const match = await findStaleKeys(db, { date: referenceDate })
    expect(match.length).toBe(4)
  })
})
