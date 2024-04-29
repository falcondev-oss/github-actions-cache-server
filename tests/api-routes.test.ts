import ky from 'ky'
import { beforeEach, describe, expect, test } from 'vitest'

import { storageAdapter } from '~/lib/storage'
import type { ArtifactCacheEntry, ReserveCacheResponse } from '~/lib/types'
import { cacheApi } from '~/tests/utils'

describe('api routes', () => {
  beforeEach(() => storageAdapter.pruneCaches())

  test('single concurrent upload', async () => {
    const testData = new TextEncoder().encode('Hello world!').buffer

    // reserve
    const reserveRes = await cacheApi.post('caches', {
      json: {
        cacheSize: testData.byteLength,
        key: 'cache-a',
        version: 'version',
      },
    })

    expect(reserveRes.status, 'Reserve').toBe(200)

    const cacheId = await reserveRes.json<ReserveCacheResponse>().then((r) => r.cacheId)
    expect(cacheId, 'Reserve').toBeTruthy()

    // upload
    const uploadRes = await cacheApi.patch(`caches/${cacheId}`, {
      body: testData,
      headers: {
        'content-range': `bytes 0-${testData.byteLength - 1}/*`,
      },
    })
    expect(uploadRes.status, 'Upload').toBe(204)

    // commit
    const commitRes = await cacheApi.post(`caches/${cacheId}`, {
      json: {
        size: testData.byteLength,
      },
    })
    expect(commitRes.status, 'Commit').toBe(204)

    // get
    const getRes = await cacheApi.get(`cache?keys=cache-a&version=version`)
    expect(getRes.status, 'Get').toBe(200)
    const readData = await getRes.json<ArtifactCacheEntry>()
    expect(readData.archiveLocation, 'Get').toBeDefined()

    // download
    const downloadRes = await ky.get(readData.archiveLocation)
    expect(downloadRes.status, 'Download').toBe(200)
    expect(await downloadRes.text(), 'Download').toBe('Hello world!')
  })

  test('multiple concurrent reserves', async () => {
    const reserveRes = await cacheApi.post('caches', {
      json: {
        cacheSize: 10,
        key: 'cache-a',
        version: 'version',
      },
    })
    const reservedCacheId = await reserveRes.json<ReserveCacheResponse>().then((r) => r.cacheId)
    expect(reservedCacheId, 'Reserve 1').toBeTruthy()

    const reserveRes2 = await cacheApi.post('caches', {
      json: {
        cacheSize: 10,
        key: 'cache-a',
        version: 'version',
      },
    })
    const reservedCacheId2 = await reserveRes2.json<ReserveCacheResponse>().then((r) => r.cacheId)
    expect(reservedCacheId2, 'Reserve 2').toBeNull()
  })

  test('read non-existent cache', async () => {
    const firstGetRes = await cacheApi.get(`cache?keys=cache-not-found&version=version`)
    expect(firstGetRes.status, 'Get').toBe(204)
  })
})
