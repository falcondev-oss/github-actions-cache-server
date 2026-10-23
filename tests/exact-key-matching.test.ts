import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { expect, test } from 'vitest'
import { getStorage } from '~/lib/storage'

// Mirrors GitHub's cache service, which matches keys exactly
test('keys differing only in case, accents or trailing spaces stay separate cache entries', async () => {
  const storage = await getStorage()
  const base = { version: 'v1', scope: 'refs/heads/main', repoId: '123' }
  const id = randomUUID()
  const match = (...keys: [string, ...string[]]) =>
    storage.matchCacheEntry({ ...base, keys, scopes: [base.scope] })
  async function save(key: string) {
    const { id: uploadId } = await storage.createUpload({ ...base, key })
    await storage.uploadPart(uploadId, 0, Readable.from(key))
    await storage.completeUpload({ ...base, key })
  }

  await save(`CaseFoo-${id}`)
  await save(`Café-${id}`)
  await save(`Pad-${id}`)

  await expect(match(`casefoo-${id}`)).resolves.toBeUndefined()
  await expect(match(`nomatch-${id}`, 'casefoo-')).resolves.toBeUndefined()
  await expect(match(`Cafe-${id}`)).resolves.toBeUndefined()
  await expect(match(`Pad-${id} `)).resolves.toBeUndefined()

  await save(`casefoo-${id}`)

  const upper = await match(`CaseFoo-${id}`)
  const lower = await match(`casefoo-${id}`)
  expect(upper?.match.key).toBe(`CaseFoo-${id}`)
  expect(lower?.match.key).toBe(`casefoo-${id}`)
  expect(lower?.match.locationId).not.toBe(upper?.match.locationId)
})
