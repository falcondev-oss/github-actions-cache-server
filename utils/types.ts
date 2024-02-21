import type { Buffer } from 'node:buffer'

export interface StorageDriver {
  upload: (buffer: Buffer, objectName: string) => Promise<void> | void
  download: (objectName: string) => Promise<ReadableStream> | ReadableStream
}

export interface StorageAdapter {
  getCacheEntry: (keys: string[], version: string) => Promise<ArtifactCacheEntry | null>
  download: (objectName: string) => Promise<ReadableStream>
  uploadChunk: (
    cacheId: number,
    chunkStream: ReadableStream<Buffer>,
    chunkStart: number,
    chunkEnd: number,
  ) => Promise<void>
  commitCache: (cacheId: number, size: number) => Promise<void>
  reserveCache: (key: string, version: string, cacheSize: number) => Promise<ReserveCacheResponse>
}

export interface ArtifactCacheEntry {
  cacheKey?: string
  archiveLocation: string
}

export interface ReserveCacheResponse {
  cacheId: number | null
}
