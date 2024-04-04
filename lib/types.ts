import type { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'

export interface StorageDriver {
  upload: (buffer: Buffer, objectName: string) => Promise<void> | void
  download: (objectName: string) => Promise<Readable> | Readable
  prune: () => Promise<void> | void
}

export interface StorageAdapter {
  getCacheEntry: (keys: string[], version: string) => Promise<ArtifactCacheEntry | null>
  download: (objectName: string) => Promise<Readable>
  uploadChunk: (
    uploadId: number,
    chunkStream: ReadableStream<Buffer>,
    chunkStart: number,
    chunkEnd: number,
  ) => Promise<void>
  commitCache: (uploadId: number, size: number) => Promise<void>
  reserveCache: (key: string, version: string, cacheSize: number) => Promise<ReserveCacheResponse>
  pruneCaches: () => Promise<void>
}

export interface ArtifactCacheEntry {
  cacheKey?: string
  archiveLocation: string
}

export interface ReserveCacheResponse {
  cacheId: number | null
}
