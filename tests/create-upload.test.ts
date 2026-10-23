import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { expect, test } from 'vitest'
import { getDatabase } from '~/lib/db'
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

test('completing an upload leaves a reservation differing only in key case alone', async () => {
  const storage = await getStorage()
  const db = await getDatabase()
  const base = { version: 'v1', scope: 'refs/heads/main', repoId: '123' }
  const key = `Key-${randomUUID()}`

  const upper = await storage.createUpload({ ...base, key })
  const lower = await storage.createUpload({ ...base, key: key.toLowerCase() })
  await storage.uploadPart(lower.id, 0, Readable.from('payload'))
  await storage.completeUpload({ ...base, key: key.toLowerCase() })

  const remaining = await db
    .selectFrom('uploads')
    .where('id', 'in', [upper.id, lower.id])
    .select('id')
    .execute()
  expect(remaining).toEqual([{ id: upper.id }])
})
