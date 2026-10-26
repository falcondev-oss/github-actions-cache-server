import { describe, expect, test, vi } from 'vitest'
import { getStorage } from '~/lib/storage'

const loaded = vi.hoisted(() => new Set<string>())
vi.mock('@azure/storage-blob', async (importOriginal) => {
  loaded.add('@azure/storage-blob')
  return importOriginal()
})
vi.mock('@azure/identity', async (importOriginal) => {
  loaded.add('@azure/identity')
  return importOriginal()
})
vi.mock('@google-cloud/storage', async (importOriginal) => {
  loaded.add('@google-cloud/storage')
  return importOriginal()
})

// Each SDK adds tens of MB of heap that every GC cycle walks.
describe.skipIf(['azblob', 'gcs'].includes(process.env.VITEST_STORAGE_DRIVER ?? ''))(
  'storage SDKs',
  () => {
    test('the SDKs of unselected drivers are not loaded', async () => {
      await getStorage()
      expect([...loaded]).toEqual([])
    })
  },
)
