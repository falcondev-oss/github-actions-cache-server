import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import pLimit from 'p-limit'
import { describe, expect, test } from 'vitest'
import { Storage } from '~/lib/storage'

describe.skipIf(process.env.VITEST_STORAGE_DRIVER !== 's3')('s3 storage', () => {
  test(
    'counts and deletes folders containing more than one listing page',
    { timeout: 120_000 },
    async () => {
      const adapter = await Storage.getAdapterFromEnv()
      const folderName = `pagination-${randomUUID()}`
      const limit = pLimit(25)

      try {
        await Promise.all(
          Array.from({ length: 1001 }, (_, index) =>
            limit(() => adapter.uploadStream(`${folderName}/${index}`, Readable.from('x'))),
          ),
        )

        expect(await adapter.countFilesInFolder(folderName)).toBe(1001)

        await adapter.deleteFolder(folderName)

        expect(await adapter.countFilesInFolder(folderName)).toBe(0)
      } finally {
        await adapter.deleteFolder(folderName)
      }
    },
  )
})
