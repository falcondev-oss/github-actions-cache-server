import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { describe, expect, test } from 'vitest'
import { Storage } from '~/lib/storage'

describe.skipIf((process.env.VITEST_STORAGE_DRIVER ?? 'filesystem') !== 'filesystem')(
  'filesystem storage',
  () => {
    test('uploads become visible atomically and leave no temp residue', async () => {
      const adapter = await Storage.getAdapterFromEnv()
      const folderName = `atomic-${randomUUID()}`

      try {
        await adapter.uploadStream(`${folderName}/parts/0`, Readable.from('part-data'))
        expect(await adapter.countFilesInFolder(`${folderName}/parts`)).toBe(1)

        const failingStream = new Readable({
          read() {
            this.destroy(new Error('interrupted upload'))
          },
        })
        await expect(adapter.uploadStream(`${folderName}/parts/1`, failingStream)).rejects.toThrow(
          'interrupted upload',
        )

        // A failed upload must not become visible or count as a Part.
        expect(await adapter.countFilesInFolder(`${folderName}/parts`)).toBe(1)
        const folders = await adapter.listStorageFolders()
        expect(folders.filter((folder) => folder.folderName.startsWith('tmp-'))).toEqual([])
      } finally {
        await adapter.deleteFolder(folderName)
      }
    })
  },
)
