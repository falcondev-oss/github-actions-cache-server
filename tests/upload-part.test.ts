import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { afterEach, expect, test, vi } from 'vitest'
import { getDatabase } from '~/lib/db'
import { getStorage } from '~/lib/storage'

// one past the 10-digit range `generateNumberId` draws from
const UNKNOWN_UPLOAD_ID = 10_000_000_000

afterEach(() => vi.restoreAllMocks())

test('a block for an unknown upload is answered with 404 and not stored', async () => {
  const storage = await getStorage()
  const uploadStream = vi.spyOn(storage.adapter, 'uploadStream')

  const res = await fetch(`http://localhost:3000/devstoreaccount1/upload/${UNKNOWN_UPLOAD_ID}`, {
    method: 'PUT',
    body: 'payload',
  })
  expect(res.status).toBe(404)

  expect(await storage.uploadPart(UNKNOWN_UPLOAD_ID, 0, Readable.from('payload'))).toBe(false)
  expect(uploadStream).not.toHaveBeenCalled()
})

test('a block whose upload is deleted while it streams is reported as not stored', async () => {
  const [storage, db] = await Promise.all([getStorage(), getDatabase()])
  const upload = await storage.createUpload({
    key: `upload-part-${randomUUID()}`,
    version: 'v1',
    scope: 'refs/heads/main',
    repoId: '123',
  })
  // `cleanup:uploads` removing the row mid-block
  vi.spyOn(storage.adapter, 'uploadStream').mockImplementation(async (_name, stream) => {
    await db.deleteFrom('uploads').where('id', '=', upload.id).execute()
    for await (const _chunk of stream);
  })

  expect(await storage.uploadPart(upload.id, 0, Readable.from('payload'))).toBe(false)
})
