import type { StorageAdapter } from '~/lib/storage'
import { randomUUID } from 'node:crypto'

import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { Storage } from '~/lib/storage'

describe.skipIf(process.env.VITEST_STORAGE_DRIVER !== 'azblob')('azblob storage', () => {
  test('createDownloadUrl returns a URL that resolves to the uploaded content', async () => {
    const adapter: StorageAdapter = await Storage.getAdapterFromEnv()

    const folderName = `direct-download-${randomUUID()}`
    const objectName = `${folderName}/blob`
    const payload = `hello-${randomUUID()}`

    try {
      await adapter.uploadStream(objectName, Readable.from(payload))

      const url = await adapter.createDownloadUrl!(objectName, Date.now() + 60_000)

      const response = await fetch(url)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(payload)
    } finally {
      await adapter.deleteFolder(folderName)
    }
  })
})
