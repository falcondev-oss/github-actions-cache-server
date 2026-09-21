import { Readable } from 'node:stream'

import { describe, expect, test } from 'vitest'
import { Storage } from '~/lib/storage'

describe('storage folder isolation', () => {
  test('folder-scoped operations do not match sibling folders with the same prefix', async () => {
    const adapter = await Storage.getAdapterFromEnv()

    try {
      await adapter.uploadStream('abc/merged', Readable.from('a'))
      await adapter.uploadStream('abc123/merged', Readable.from('bb'))

      expect(await adapter.countFilesInFolder('abc')).toBe(1)
      const objects = await adapter.listFolder('abc')
      expect(objects).toHaveLength(1)
      expect(objects.reduce((total, o) => total + o.bytes, 0)).toBe(1)

      expect(await adapter.deleteFolder('abc')).toEqual({ objects: 1, bytes: 1 })

      expect(await adapter.objectExists('abc123/merged')).toBe(true)
    } finally {
      await adapter.deleteFolder('abc')
      await adapter.deleteFolder('abc123')
    }
  })
})
