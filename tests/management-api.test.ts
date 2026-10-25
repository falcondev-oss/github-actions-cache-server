import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { expect, test } from 'vitest'
import { getDatabase } from '~/lib/db'
import { getStorage } from '~/lib/storage'

async function saveEntry(entry: { key: string; version: string; scope: string; repoId: string }) {
  const storage = await getStorage()
  const upload = await storage.createUpload(entry)
  await storage.uploadPart(upload.id, 0, Readable.from(['payload']))
  await storage.completeUpload(entry)
}

async function countEntries(key: string, repoId: string) {
  const db = await getDatabase()
  const { count } = await db
    .selectFrom('cache_entries')
    .where('key', '=', key)
    .where('repoId', '=', repoId)
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
  return Number(count)
}

test('deleting cache entries by repoId leaves other repositories alone', async () => {
  const key = `management-delete-${randomUUID()}`
  const entry = { key, version: 'v1', scope: 'refs/heads/main' }
  await saveEntry({ ...entry, repoId: 'kept' })
  await saveEntry({ ...entry, repoId: 'deleted' })

  const res = await fetch('http://localhost:3000/management-api/cache-entries', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-api-key': 'vitest-management-api-key' },
    body: JSON.stringify({ repoId: 'deleted' }),
  })
  expect(res.ok).toBe(true)

  expect(await countEntries(key, 'deleted')).toBe(0)
  expect(await countEntries(key, 'kept')).toBe(1)
})
