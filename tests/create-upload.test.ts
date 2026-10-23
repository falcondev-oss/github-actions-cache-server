import { randomUUID } from 'node:crypto'

import { expect, test } from 'vitest'
import { AlreadyExistsError, getStorage } from '~/lib/storage'

test('concurrent duplicate reservations create exactly one upload', async () => {
  const storage = await getStorage()
  const reservation = { key: randomUUID(), version: 'v1', scope: 'refs/heads/main', repoId: '123' }

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => storage.createUpload(reservation)),
  )

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))).toEqual(
    Array.from({ length: 9 }, () => expect.any(AlreadyExistsError)),
  )
})
