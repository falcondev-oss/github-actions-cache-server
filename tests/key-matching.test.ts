import { describe, expect, it } from 'vitest'

import { cacheApi } from '@/tests/utils'

describe('test', () => {
  it('should work', async () => {
    const res = await cacheApi.get('/cache')
    expect(res.status).toBe(400)
  })
})
