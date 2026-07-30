/* eslint-disable ts/method-signature-style */
import type { Kysely } from 'kysely'
import type { ReadableStream } from 'node:stream/web'
import type { Database, StorageLocation } from './db'
import type { Env } from './schemas'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { Agent } from 'node:https'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createSingletonPromise } from '@antfu/utils'
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload as S3Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { DefaultAzureCredential } from '@azure/identity'
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob'
import { Storage as GcsClient } from '@google-cloud/storage'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { sql } from 'kysely'
import { chunk } from 'remeda'
import { match } from 'ts-pattern'
import { getDatabase, retryOnLockConflict } from './db'
import { env } from './env'
import { generateNumberId } from './helpers'
import { logger } from './logger'
import {
  acquireMergeLease,
  createReaderLease,
  DIRECT_DOWNLOAD_LEASE_DURATION_MS,
  LEASE_RENEWAL_MS,
  releaseMergeLease,
  releaseReaderLease,
  renewMergeLease,
  renewReaderLease,
} from './storage-leases'
import { deleteStorageLocationIfUnread, noActiveReaderLease } from './storage-lifecycle'

// Bounds the self-heal retry when matching keeps surfacing Dangling Cache
// Entries for the same prefix — caps a pathological scan (ADR-0005).
const MAX_DANGLING_PURGE_ATTEMPTS = 10

function escapeLikePattern(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', String.raw`\%`)
    .replaceAll('_', String.raw`\_`)
}

export class ObjectNotFoundError extends Error {
  constructor(objectName: string) {
    super(`Object not found in storage: ${objectName}`)
    this.name = 'ObjectNotFoundError'
  }
}

export class Storage {
  static async fromEnv() {
    const storage = new Storage({
      adapter: await this.getAdapterFromEnv(),
      db: await getDatabase(),
    })
    await storage.reconcileStorageLocationSizes()
    return storage
  }

  static async getAdapterFromEnv() {
    return await match(env)
      .with({ STORAGE_DRIVER: 's3' }, S3Adapter.fromEnv)
      .with({ STORAGE_DRIVER: 'filesystem' }, FileSystemAdapter.fromEnv)
      .with({ STORAGE_DRIVER: 'gcs' }, GcsAdapter.fromEnv)
      .with({ STORAGE_DRIVER: 'azblob' }, AzBlobAdapter.fromEnv)
      .exhaustive()
  }

  private db
  private mergeStreamPromises = new Set<Promise<void>>()
  adapter

  private constructor({ db, adapter }: { adapter: StorageAdapter; db: Kysely<Database> }) {
    this.adapter = adapter
    this.db = db
  }

  private async abandonUpload(uploadId: number, folderName: string, reason: Error): Promise<never> {
    await this.db.deleteFrom('uploads').where('id', '=', uploadId).execute()
    try {
      await this.adapter.deleteFolder(folderName)
    } catch (err) {
      throw new AggregateError([reason, err], reason.message)
    }
    throw reason
  }

  private protectDownloadStream(stream: Readable, readerLeaseId: string) {
    const renewalTimer = setInterval(() => {
      void renewReaderLease(this.db, readerLeaseId)
        .then((renewed) => {
          if (!renewed) stream.destroy(new Error('Storage Reader Lease was lost'))
        })
        .catch((err) => stream.destroy(err))
    }, LEASE_RENEWAL_MS)
    renewalTimer.unref()
    let released = false
    const release = () => {
      if (released) return
      released = true
      clearInterval(renewalTimer)
      void releaseReaderLease(this.db, readerLeaseId)
    }
    stream.once('end', release)
    stream.once('close', release)
    stream.once('error', release)
    return stream
  }

  private async ensurePartsExist(location: StorageLocation) {
    const partsFolder = `${location.folderName}/parts`
    const actualPartCount = await this.adapter.countFilesInFolder(partsFolder)
    if (actualPartCount < location.partCount) throw new ObjectNotFoundError(partsFolder)
  }

  private async downloadFromCacheEntryLocation(location: StorageLocation) {
    if (location.mergedAt) return this.adapter.createDownloadStream(`${location.folderName}/merged`)

    await this.ensurePartsExist(location)
    return Readable.from(this.streamParts(location))
  }

  private async pumpPartsToStreams(
    location: StorageLocation,
    responseStream: PassThrough,
    mergerStream: PassThrough,
  ) {
    if (location.partsDeletedAt) throw new Error('No parts to feed')

    for await (const chunk of this.streamParts(location)) {
      // attach both drain listeners simultaneously to prevent a race condition where the second stream being faster hangs forever
      const drains = []
      if (!responseStream.write(chunk)) drains.push(once(responseStream, 'drain'))
      if (!mergerStream.write(chunk)) drains.push(once(mergerStream, 'drain'))
      await Promise.all(drains)
    }

    responseStream.end()
    mergerStream.end()

    await globalThis.gc?.()
  }

  private async *streamParts(location: StorageLocation) {
    if (location.partsDeletedAt) throw new Error('No parts to feed for location with deleted parts')

    for (let i = 0; i < location.partCount; i++) {
      const partStream = await this.adapter.createDownloadStream(
        `${location.folderName}/parts/${i}`,
      )

      for await (const chunk of partStream) yield chunk

      await globalThis.gc?.()
    }
  }

  /**
   * True iff the entry's storage physically exists. A merged entry is confirmed
   * by its merged object; an unmerged entry by its first Part. Parts deleted
   * without a completed merge means the data is gone. See ADR-0005.
   */
  private async storageHasData(location: {
    folderName: string
    partCount: number
    mergedAt: number | null
    partsDeletedAt: number | null
  }) {
    if (location.mergedAt) return this.adapter.objectExists(`${location.folderName}/merged`)
    if (location.partsDeletedAt || location.partCount === 0) return false
    // ponytail: single-part HEAD, not a full LIST of parts. External drift wipes
    // the whole folder and the server never produces partial Part loss, so
    // Part 0's absence is a sufficient proxy. Won't catch surgical deletion of
    // an interior Part. See ADR-0005.
    return this.adapter.objectExists(`${location.folderName}/parts/0`)
  }

  private async purgeDanglingCacheEntry(cacheEntryId: string, locationId: string) {
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('cache_entries').where('id', '=', cacheEntryId).execute()
      // Reap the now-childless Storage Location too: an Orphaned Storage sweep
      // scans physical storage and can never see a row whose data is already
      // gone. Respects reader leases per ADR-0002.
      await deleteStorageLocationIfUnread(tx, locationId)
    })
  }

  private async reconcileStorageLocationSizes() {
    // Backfill rows predating size tracking. One full-bucket LIST at startup,
    // then a no-op once every row has a size (the `is null` guard).
    const missing = await this.db
      .selectFrom('storage_locations')
      .select(['id', 'folderName'])
      .where('sizeBytes', 'is', null)
      .execute()
    if (missing.length === 0) return

    const storedFolders = await this.adapter.listStorageFolders()
    const sizes = new Map(storedFolders.map(({ folderName, bytes }) => [folderName, bytes]))
    for (const location of missing) {
      await this.db
        .updateTable('storage_locations')
        .set({ sizeBytes: sizes.get(location.folderName) ?? 0 })
        .where('id', '=', location.id)
        .where('sizeBytes', 'is', null)
        .execute()
    }
  }

  waitForOngoingMerges() {
    return Promise.all(this.mergeStreamPromises)
  }

  async uploadPart(uploadId: number, partIndex: number, stream: ReadableStream) {
    const upload = await this.db
      .selectFrom('uploads')
      .where('id', '=', uploadId)
      .select(['folderName'])
      .executeTakeFirst()
    if (!upload) return

    await this.db
      .updateTable('uploads')
      .set({
        startedPartUploadCount: sql`${sql.ref('startedPartUploadCount')} + 1`,
      })
      .where('id', '=', uploadId)
      .execute()

    await this.adapter.uploadStream(
      `${upload.folderName}/parts/${partIndex}`,
      Readable.fromWeb(stream),
    )

    await this.db
      .updateTable('uploads')
      .set({
        lastPartUploadedAt: Date.now(),
        finishedPartUploadCount: sql`${sql.ref('finishedPartUploadCount')} + 1`,
      })
      .where('id', '=', uploadId)
      .execute()
  }

  async completeUpload({
    key,
    version,
    scope,
    repoId,
  }: {
    key: string
    version: string
    scope: string
    repoId: string
  }) {
    const upload = await this.db
      .selectFrom('uploads')
      .where('key', '=', key)
      .where('version', '=', version)
      .where('scope', '=', scope)
      .where('repoId', '=', repoId)
      .selectAll()
      .executeTakeFirst()
    if (!upload) return

    if (upload.finishedPartUploadCount === 0) {
      return this.abandonUpload(
        upload.id,
        upload.folderName,
        new Error('No parts have been uploaded'),
      )
    }

    if (upload.startedPartUploadCount !== upload.finishedPartUploadCount) {
      return this.abandonUpload(
        upload.id,
        upload.folderName,
        new Error(
          `Not all parts have been uploaded (only ${upload.finishedPartUploadCount} of ${upload.startedPartUploadCount} parts uploaded)`,
        ),
      )
    }

    const partCount = await this.adapter.countFilesInFolder(`${upload.folderName}/parts`)
    if (partCount !== upload.finishedPartUploadCount) {
      return this.abandonUpload(
        upload.id,
        upload.folderName,
        new Error(
          `Uploaded part count does not match actual part count in storage (expected ${upload.finishedPartUploadCount} but found ${partCount})`,
        ),
      )
    }

    const sizeBytes = await this.adapter.getFolderSize(upload.folderName)

    await this.db.transaction().execute(async (tx) => {
      const locationId = randomUUID()
      await tx
        .insertInto('storage_locations')
        .values({
          id: locationId,
          folderName: upload.folderName,
          partCount,
          mergedAt: null,
          mergeStartedAt: null,
          partsDeletedAt: null,
          lastDownloadedAt: null,
          sizeBytes,
        })
        .execute()

      const existingCacheEntry = await tx
        .selectFrom('cache_entries')
        .where('key', '=', key)
        .where('version', '=', version)
        .where('scope', '=', scope)
        .where('repoId', '=', repoId)
        .innerJoin('storage_locations', 'storage_locations.id', 'cache_entries.locationId')
        .select(['cache_entries.id', 'cache_entries.locationId'])
        .executeTakeFirst()

      if (existingCacheEntry) {
        await tx
          .updateTable('cache_entries')
          .set({
            updatedAt: Date.now(),
            locationId,
          })
          .where('id', '=', existingCacheEntry.id)
          .execute()
      } else
        await tx
          .insertInto('cache_entries')
          .values({
            key: upload.key,
            version: upload.version,
            id: randomUUID(),
            updatedAt: Date.now(),
            locationId,
            scope,
            repoId,
          })
          .execute()

      await tx.deleteFrom('uploads').where('id', '=', upload.id).execute()
    })

    try {
      await this.enforceStorageBudget()
    } catch (err) {
      logger.warn('Capacity-based Eviction failed after upload completion', { error: err })
    }

    return upload
  }

  async enforceStorageBudget() {
    const filesystemUsage = env.CACHE_MAX_SIZE_BYTES
      ? undefined
      : await this.adapter.getFilesystemUsage?.()
    const budget =
      env.CACHE_MAX_SIZE_BYTES ??
      (filesystemUsage &&
        Math.floor((filesystemUsage.capacityBytes * env.CACHE_FILESYSTEM_MAX_USAGE_PERCENT) / 100))
    if (!budget) return

    const target = Math.floor(budget * 0.9)
    const storedUsage = filesystemUsage
      ? undefined
      : await this.db
          .selectFrom('storage_locations')
          .select(sql<number>`coalesce(sum(${sql.ref('sizeBytes')}), 0)`.as('bytes'))
          .executeTakeFirstOrThrow()
    let usage = filesystemUsage ? filesystemUsage.usedBytes : Number(storedUsage!.bytes)
    if (usage <= budget) return

    const locations = await this.db
      .selectFrom('storage_locations')
      .leftJoin('cache_entries', 'cache_entries.locationId', 'storage_locations.id')
      .select([
        'storage_locations.id',
        'storage_locations.folderName',
        'storage_locations.sizeBytes',
      ])
      .where((eb) => noActiveReaderLease(eb))
      .orderBy(sql`coalesce(${sql.ref('lastDownloadedAt')}, ${sql.ref('updatedAt')}, 0)`, 'asc')
      .execute()

    for (const location of locations) {
      if (usage <= target) break
      const deleted = await this.db
        .transaction()
        .execute((tx) => deleteStorageLocationIfUnread(tx, location.id))
      if (!deleted) continue
      await this.adapter.deleteFolder(location.folderName)
      if (filesystemUsage) {
        const currentUsage = await this.adapter.getFilesystemUsage!()
        usage = currentUsage.usedBytes
      } else usage -= location.sizeBytes ?? 0
    }
  }

  async download(cacheEntryId: string): Promise<Readable | undefined> {
    const protectedLocation = await this.db.transaction().execute(async (tx) => {
      let query = tx
        .selectFrom('storage_locations')
        .innerJoin('cache_entries', 'cache_entries.locationId', 'storage_locations.id')
        .where('cache_entries.id', '=', cacheEntryId)
        .selectAll('storage_locations')
      if (env.DB_DRIVER !== 'sqlite') query = query.forUpdate()
      const storageLocation = await query.executeTakeFirst()
      if (!storageLocation) return
      const readerScope = storageLocation.mergedAt ? 'storage' : 'parts'
      const readerLeaseId = await createReaderLease(tx, storageLocation.id, readerScope)
      return { storageLocation, readerLeaseId }
    })
    if (!protectedLocation) return
    const { storageLocation, readerLeaseId } = protectedLocation

    void this.db
      .updateTable('storage_locations')
      .set({
        lastDownloadedAt: Date.now(),
      })
      .where('id', '=', storageLocation.id)
      .execute()

    try {
      if (storageLocation.mergedAt) {
        const stream = await this.downloadFromCacheEntryLocation(storageLocation)
        return this.protectDownloadStream(stream, readerLeaseId)
      }

      await this.ensurePartsExist(storageLocation)

      const mergeToken = await acquireMergeLease(this.db, storageLocation.id)
      if (!mergeToken) {
        const stream = await this.downloadFromCacheEntryLocation(storageLocation)
        return this.protectDownloadStream(stream, readerLeaseId)
      }

      await this.db
        .updateTable('storage_locations')
        .set({
          mergeStartedAt: Date.now(),
        })
        .where('id', '=', storageLocation.id)
        .execute()

      const responseStream = new PassThrough()
      const mergerStream = new PassThrough()
      const renewalTimer = setInterval(() => {
        void renewMergeLease(this.db, storageLocation.id, mergeToken)
      }, LEASE_RENEWAL_MS)
      renewalTimer.unref()

      // Uploading straight to the final object is safe: uploads are atomically
      // visible (see StorageAdapter.uploadStream) and Parts are immutable, so a
      // merger that lost its lease can only overwrite `merged` with identical
      // bytes — the fence only needs to guard who flips `mergedAt`.
      const mergePromise = this.adapter
        .uploadStream(`${storageLocation.folderName}/merged`, mergerStream)
        .then(async () => {
          // The merged object is already written, so losing a deadlock here must
          // not throw the merge away — the fence is re-checked on every attempt.
          await retryOnLockConflict(() =>
            this.db.transaction().execute(async (tx) => {
              let leaseQuery = tx
                .selectFrom('merge_leases')
                .select(['token', 'expiresAt'])
                .where('storageLocationId', '=', storageLocation.id)
              if (env.DB_DRIVER !== 'sqlite') leaseQuery = leaseQuery.forUpdate()
              const lease = await leaseQuery.executeTakeFirst()
              if (lease?.token !== mergeToken || lease.expiresAt <= Date.now())
                throw new Error('Merge lease was lost before completion')
              await tx
                .updateTable('storage_locations')
                .set({ mergedAt: Date.now() })
                .where('id', '=', storageLocation.id)
                .execute()
            }),
          )
        })
        .catch(async (err) => {
          logger.error(`Merge failed for storage location ${storageLocation.id}`, { error: err })
          await this.db
            .updateTable('storage_locations')
            .set({
              mergedAt: null,
              mergeStartedAt: null,
            })
            .where('id', '=', storageLocation.id)
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom('merge_leases')
                  .select('storageLocationId')
                  .whereRef('storageLocationId', '=', 'storage_locations.id')
                  .where('token', '=', mergeToken),
              ),
            )
            .execute()
          mergerStream.destroy()
        })
        .finally(async () => {
          clearInterval(renewalTimer)
          await releaseMergeLease(this.db, storageLocation.id, mergeToken)
        })
      this.mergeStreamPromises.add(mergePromise)
      mergePromise.finally(() => this.mergeStreamPromises.delete(mergePromise))

      this.pumpPartsToStreams(storageLocation, responseStream, mergerStream).catch((err) => {
        responseStream.destroy(err)
        mergerStream.destroy(err)
        if (err instanceof ObjectNotFoundError)
          logger.warn(`Stale cache entry ${cacheEntryId}: ${err.message}`)
      })

      return this.protectDownloadStream(responseStream, readerLeaseId)
    } catch (err) {
      await releaseReaderLease(this.db, readerLeaseId)
      if (err instanceof ObjectNotFoundError) {
        logger.warn(`Stale cache entry ${cacheEntryId}: ${err.message}`)
        return
      }
      throw err
    }
  }

  async createUpload({
    key,
    version,
    scope,
    repoId,
  }: {
    key: string
    version: string
    scope: string
    repoId: string
  }) {
    const existingUpload = await this.db
      .selectFrom('uploads')
      .where('key', '=', key)
      .where('version', '=', version)
      .where('scope', '=', scope)
      .where('repoId', '=', repoId)
      .select('id')
      .executeTakeFirst()
    if (existingUpload) return

    const uploadId = generateNumberId()
    await this.db
      .insertInto('uploads')
      .values({
        id: uploadId,
        folderName: uploadId.toString(),
        createdAt: Date.now(),
        key,
        version,
        scope,
        repoId,
        lastPartUploadedAt: null,
        finishedPartUploadCount: 0,
        startedPartUploadCount: 0,
      })
      .execute()

    return { id: uploadId }
  }

  async matchCacheEntry({
    keys,
    version,
    scopes,
    repoId,
  }: {
    keys: [string, ...string[]]
    version: string
    scopes: string[]
    repoId: string
  }) {
    const [primaryKey, ...restoreKeys] = keys
    for (const scope of scopes) {
      const exactPrimaryMatch = await this.db
        .selectFrom('cache_entries')
        .where('key', '=', primaryKey)
        .where('version', '=', version)
        .where('scope', '=', scope)
        .where('repoId', '=', repoId)
        .selectAll()
        .executeTakeFirst()
      if (exactPrimaryMatch)
        return {
          match: exactPrimaryMatch,
          type: 'exact-primary' as const,
        }

      const prefixedPrimaryMatch = await this.db
        .selectFrom('cache_entries')
        .where(
          sql<boolean>`${sql.ref('key')} like ${`${escapeLikePattern(primaryKey)}%`} escape ${'\\'}`,
        )
        .where('version', '=', version)
        .where('scope', '=', scope)
        .where('repoId', '=', repoId)
        .orderBy('cache_entries.updatedAt', 'desc')
        .selectAll()
        .executeTakeFirst()

      if (prefixedPrimaryMatch)
        return {
          match: prefixedPrimaryMatch,
          type: 'prefixed-primary' as const,
        }

      if (restoreKeys.length === 0) continue

      for (const key of restoreKeys) {
        const exactMatch = await this.db
          .selectFrom('cache_entries')
          .where('key', '=', key)
          .where('version', '=', version)
          .where('scope', '=', scope)
          .where('repoId', '=', repoId)
          .orderBy('updatedAt', 'desc')
          .selectAll()
          .executeTakeFirst()
        if (exactMatch)
          return {
            match: exactMatch,
            type: 'exact-restore' as const,
          }

        const prefixedMatch = await this.db
          .selectFrom('cache_entries')
          .where(
            sql<boolean>`${sql.ref('key')} like ${`${escapeLikePattern(key)}%`} escape ${'\\'}`,
          )
          .where('version', '=', version)
          .where('scope', '=', scope)
          .where('repoId', '=', repoId)
          .orderBy('updatedAt', 'desc')
          .selectAll()
          .executeTakeFirst()

        if (prefixedMatch)
          return {
            match: prefixedMatch,
            type: 'prefixed-restore' as const,
          }
      }
    }
  }

  async getCacheEntryWithDownloadUrl(args: Parameters<typeof this.matchCacheEntry>[0]) {
    // Returning a download URL is a promise the data exists — the client commits
    // to downloading and can't walk a later 404 back to a cache miss (BuildKit
    // hard-fails the build). So validate storage before handing out a URL: a
    // Dangling Cache Entry is self-healed and matching retried, so a valid
    // candidate under another restore key still wins. See ADR-0005.
    for (let attempt = 0; attempt < MAX_DANGLING_PURGE_ATTEMPTS; attempt++) {
      const cacheEntry = await this.matchCacheEntry(args)
      if (!cacheEntry) return

      const location = await this.db
        .selectFrom('storage_locations')
        .where('id', '=', cacheEntry.match.locationId)
        .select(['id', 'folderName', 'partCount', 'mergedAt', 'partsDeletedAt'])
        .executeTakeFirst()

      if (!location || !(await this.storageHasData(location))) {
        logger.warn(
          `Cache entry ${cacheEntry.match.id} (${cacheEntry.match.key}) is a Dangling Cache Entry, purging.`,
        )
        await this.purgeDanglingCacheEntry(cacheEntry.match.id, cacheEntry.match.locationId)
        continue
      }

      const defaultUrl = `${env.API_BASE_URL}/download/${cacheEntry.match.id}`

      if (!env.ENABLE_DIRECT_DOWNLOADS || !this.adapter.createDownloadUrl || !location.mergedAt)
        return {
          downloadUrl: defaultUrl,
          cacheEntry: cacheEntry.match,
        }

      // Merged entry with direct downloads enabled: take a reader lease bounded
      // by the signed URL lifetime, then sign.
      const directDownloadExpiresAt = Date.now() + DIRECT_DOWNLOAD_LEASE_DURATION_MS
      const leased = await this.db.transaction().execute(async (tx) => {
        let query = tx
          .selectFrom('storage_locations')
          .where('id', '=', location.id)
          .select(['id', 'folderName', 'mergedAt'])
        if (env.DB_DRIVER !== 'sqlite') query = query.forUpdate()
        const current = await query.executeTakeFirst()
        if (!current?.mergedAt) return current
        await createReaderLease(tx, current.id, 'storage', directDownloadExpiresAt)
        await tx
          .updateTable('storage_locations')
          .set({ lastDownloadedAt: Date.now() })
          .where('id', '=', current.id)
          .execute()
        return current
      })
      if (!leased) throw new Error('Storage location not found')

      // The merge could have been undone between validation and the lease read.
      const downloadUrl = leased.mergedAt
        ? await this.adapter.createDownloadUrl(
            `${leased.folderName}/merged`,
            directDownloadExpiresAt,
          )
        : defaultUrl

      return {
        downloadUrl,
        cacheEntry: cacheEntry.match,
      }
    }

    logger.warn('Exhausted Dangling Cache Entry purge attempts; returning cache miss.')
  }
}

export const getStorage = createSingletonPromise(async () => Storage.fromEnv())

export interface StorageAdapter {
  createDownloadStream(objectName: string): Promise<Readable>
  /**
   * Uploads must be atomically visible: an object never exists partially, and
   * overwriting an object never disturbs active readers of the previous
   * version. Object stores give this natively; the filesystem adapter writes
   * to a temp path and renames. See ADR-0004.
   */
  uploadStream(objectName: string, stream: Readable): Promise<void>
  objectExists(objectName: string): Promise<boolean>
  deleteFolder(folderName: string): Promise<StorageDeletion>
  countFilesInFolder(folderName: string): Promise<number>
  getFolderSize(folderName: string): Promise<number>
  listStorageFolders(): Promise<StorageFolder[]>
  createDownloadUrl?(objectName: string, expiresAt: number): Promise<string>
  getFilesystemUsage?(): Promise<{ capacityBytes: number; usedBytes: number }>
  clear(): Promise<void>
}

export interface StorageFolder {
  folderName: string
  objectCount: number
  bytes: number
  updatedAt: number
}

export interface StorageDeletion {
  objects: number
  bytes: number
}

function accumulateFolder(
  folders: Map<string, StorageFolder>,
  folderName: string,
  size: number,
  updatedAt: number,
) {
  const existing = folders.get(folderName) ?? { folderName, objectCount: 0, bytes: 0, updatedAt: 0 }
  existing.objectCount++
  existing.bytes += size
  existing.updatedAt = Math.max(existing.updatedAt, updatedAt)
  folders.set(folderName, existing)
}

class S3Adapter implements StorageAdapter {
  static async fromEnv(env: Extract<Env, { STORAGE_DRIVER: 's3' }>) {
    const bucket = env.STORAGE_S3_BUCKET
    const agent = new Agent({
      keepAlive: true,
      maxSockets: 50,
      keepAliveMsecs: 1000,
    })
    const s3 = new S3Client({
      forcePathStyle: true,
      region: env.AWS_REGION,
      requestHandler: new NodeHttpHandler({
        httpsAgent: agent,
        socketTimeout: env.STORAGE_S3_SOCKET_TIMEOUT_MS,
      }),
    })

    try {
      await s3.send(
        new HeadBucketCommand({
          Bucket: bucket,
        }),
      )
    } catch (err: any) {
      if (err.name === 'NotFound') {
        throw new Error(`Bucket ${bucket} does not exist`)
      }
      throw err
    }

    return new S3Adapter({ s3, bucket })
  }

  private s3
  private bucket
  private keyPrefix = 'gh-actions-cache'

  constructor({ bucket, s3 }: { s3: S3Client; bucket: string }) {
    this.s3 = s3
    this.bucket = bucket
  }

  private async *listObjectsByPrefix(prefix: string) {
    let continuationToken: string | undefined

    do {
      const response = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      )

      yield response

      if (!response.IsTruncated) return
      if (!response.NextContinuationToken)
        throw new Error(
          `S3 listing for prefix "${prefix}" was truncated without a continuation token`,
        )

      continuationToken = response.NextContinuationToken
    } while (continuationToken)
  }

  private async deleteByPrefix(prefix: string) {
    const deleted = { objects: 0, bytes: 0 }
    while (true) {
      const listResponse = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
      )
      if (!listResponse.Contents || listResponse.Contents.length === 0) break

      deleted.objects += listResponse.Contents.length
      deleted.bytes += listResponse.Contents.reduce(
        (total, object) => total + (object.Size ?? 0),
        0,
      )

      const responses = await Promise.all(
        chunk(
          listResponse.Contents.filter((obj): obj is { Key: string } => !!obj.Key),
          1000,
        ).map((chunkedObjects) =>
          this.s3.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: {
                Objects: chunkedObjects.map((obj) => ({
                  Key: obj.Key,
                })),
                Quiet: true,
              },
            }),
          ),
        ),
      )
      const errors = responses.flatMap((response) => response.Errors ?? [])
      if (errors.length > 0)
        throw new Error(
          `S3 failed to delete ${errors.length} object(s): ${errors
            .map((error) => `${error.Key ?? '<unknown>'} (${error.Code ?? 'unknown error'})`)
            .join(', ')}`,
        )
    }
    return deleted
  }

  async createDownloadStream(objectName: string) {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: `${this.keyPrefix}/${objectName}`,
        }),
      )
      if (!response.Body) throw new Error('No body in S3 get object response')

      return response.Body as Readable
    } catch (err: any) {
      if (err.name === 'NoSuchKey') throw new ObjectNotFoundError(objectName)
      throw err
    }
  }

  async objectExists(objectName: string) {
    try {
      await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: `${this.keyPrefix}/${objectName}`,
        }),
      )
      return true
    } catch (err: any) {
      if (
        err.name === 'NotFound' ||
        err.name === 'NoSuchKey' ||
        err.$metadata?.httpStatusCode === 404
      )
        return false
      throw err
    }
  }

  async deleteFolder(folderName: string) {
    return this.deleteByPrefix(`${this.keyPrefix}/${folderName}/`)
  }

  async clear() {
    await this.deleteByPrefix(`${this.keyPrefix}/`)
  }

  async uploadStream(objectName: string, iterator: AsyncIterable<Uint8Array>) {
    await new S3Upload({
      client: this.s3,
      params: {
        Bucket: this.bucket,
        Key: `${this.keyPrefix}/${objectName}`,
        Body: iterator as Readable,
      },
      queueSize: 1,
      partSize: 5 * 1024 * 1024, // 5MB
      leavePartsOnError: false,
    }).done()
  }

  async countFilesInFolder(folderName: string) {
    let count = 0

    for await (const listResponse of this.listObjectsByPrefix(`${this.keyPrefix}/${folderName}/`))
      count += listResponse.Contents?.length ?? 0

    return count
  }

  async getFolderSize(folderName: string) {
    let bytes = 0

    const pages = this.listObjectsByPrefix(`${this.keyPrefix}/${folderName}/`)
    for await (const listResponse of pages)
      bytes += (listResponse.Contents ?? []).reduce((sum, object) => sum + (object.Size ?? 0), 0)

    return bytes
  }

  async listStorageFolders() {
    const folders = new Map<string, StorageFolder>()
    const prefix = `${this.keyPrefix}/`

    for await (const response of this.listObjectsByPrefix(prefix)) {
      const contents = response.Contents ?? []
      for (const object of contents) {
        if (!object.Key) continue
        if (!object.LastModified)
          throw new Error(`S3 did not return a modification time for object "${object.Key}"`)
        const relativeName = object.Key.slice(prefix.length)
        const folderName = relativeName.split('/', 1)[0]
        if (!folderName) continue

        accumulateFolder(folders, folderName, object.Size ?? 0, object.LastModified.getTime())
      }
    }

    return [...folders.values()]
  }

  async createDownloadUrl(objectName: string, expiresAt: number) {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: `${this.keyPrefix}/${objectName}`,
      }),
      {
        expiresIn: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
      },
    )
  }
}

class FileSystemAdapter implements StorageAdapter {
  static async fromEnv(env: Extract<Env, { STORAGE_DRIVER: 'filesystem' }>) {
    const rootFolder = env.STORAGE_FILESYSTEM_PATH
    await fs.mkdir(rootFolder, {
      recursive: true,
    })

    return new FileSystemAdapter({
      rootFolder,
    })
  }

  private rootFolder

  constructor({ rootFolder }: { rootFolder: string }) {
    this.rootFolder = path.resolve(rootFolder)
  }

  private safePath(name: string) {
    const resolved = path.resolve(this.rootFolder, name)
    if (!resolved.startsWith(this.rootFolder + path.sep) && resolved !== this.rootFolder)
      throw new Error(`Invalid object name`)
    return resolved
  }

  private async inspectPath(entryPath: string, folderName: string) {
    const folder: StorageFolder = { folderName, objectCount: 0, bytes: 0, updatedAt: 0 }
    const inspect = async (currentPath: string): Promise<void> => {
      let stat
      try {
        stat = await fs.lstat(currentPath)
      } catch (err: any) {
        if (err.code === 'ENOENT') return
        throw err
      }
      folder.updatedAt = Math.max(folder.updatedAt, stat.mtimeMs)
      if (stat.isSymbolicLink())
        throw new Error(`Refusing to inspect symbolic link in owned storage: ${currentPath}`)
      if (!stat.isDirectory()) {
        folder.objectCount++
        folder.bytes += stat.size
        return
      }
      const children = await fs.readdir(currentPath)
      for (const child of children) await inspect(path.join(currentPath, child))
    }
    await inspect(entryPath)
    return folder
  }

  async createDownloadStream(objectName: string) {
    const filePath = this.safePath(objectName)
    try {
      await fs.access(filePath)
    } catch {
      throw new ObjectNotFoundError(objectName)
    }
    return createReadStream(filePath)
  }

  async objectExists(objectName: string) {
    try {
      await fs.access(this.safePath(objectName))
      return true
    } catch {
      return false
    }
  }

  async deleteFolder(folderName: string) {
    const folder = await this.inspectPath(this.safePath(folderName), folderName)
    await fs.rm(this.safePath(folderName), {
      recursive: true,
      force: true,
    })
    return { objects: folder.objectCount, bytes: folder.bytes }
  }

  async clear() {
    await fs.rm(this.rootFolder, {
      recursive: true,
      force: true,
    })
    await fs.mkdir(this.rootFolder, {
      recursive: true,
    })
  }

  async getFilesystemUsage() {
    const stats = await fs.statfs(this.rootFolder)
    return {
      capacityBytes: stats.blocks * stats.bsize,
      usedBytes: (stats.blocks - stats.bavail) * stats.bsize,
    }
  }

  async uploadStream(objectName: string, stream: Readable) {
    const filePath = this.safePath(objectName)
    // Write to a top-level temp entry and rename for atomic visibility. Temp
    // entries orphaned by a crash are unauthorized top-level storage, so
    // cleanup:orphaned-storage reclaims them after the grace period. Each
    // upload gets its own entry — a shared temp directory would stay
    // perpetually fresh and never age out.
    const tempPath = this.safePath(`tmp-${randomUUID()}`)
    try {
      await pipeline(stream, createWriteStream(tempPath))
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.rename(tempPath, filePath)
    } catch (err) {
      await fs.rm(tempPath, { force: true })
      throw err
    }
  }

  async countFilesInFolder(folderName: string) {
    try {
      const dir = await fs.readdir(this.safePath(folderName), {
        withFileTypes: true,
      })
      return dir.filter((item) => item.isFile()).length
    } catch (err: any) {
      if (err.code === 'ENOENT') return 0
      throw err
    }
  }

  async getFolderSize(folderName: string) {
    const folder = await this.inspectPath(this.safePath(folderName), folderName)
    return folder.bytes
  }

  async listStorageFolders() {
    const entries = await fs.readdir(this.rootFolder, { withFileTypes: true })
    const folders: StorageFolder[] = []
    for (const entry of entries)
      folders.push(await this.inspectPath(this.safePath(entry.name), entry.name))
    return folders
  }
}

class GcsAdapter implements StorageAdapter {
  static async fromEnv(env: Extract<Env, { STORAGE_DRIVER: 'gcs' }>) {
    const bucketName = env.STORAGE_GCS_BUCKET

    const gcs = new GcsClient({
      keyFilename: env.STORAGE_GCS_SERVICE_ACCOUNT_KEY,
      apiEndpoint: env.STORAGE_GCS_ENDPOINT,
    })
    const bucket = gcs.bucket(bucketName)

    await bucket.getMetadata()

    return new GcsAdapter({
      bucket: bucketName,
      gcs,
    })
  }

  private bucket
  private keyPrefix = 'gh-actions-cache'

  constructor({ bucket, gcs }: { bucket: string; gcs: GcsClient }) {
    this.bucket = gcs.bucket(bucket)
  }

  async createDownloadStream(objectName: string) {
    const file = this.bucket.file(`${this.keyPrefix}/${objectName}`)
    const [exists] = await file.exists()
    if (!exists) throw new ObjectNotFoundError(objectName)
    return file.createReadStream()
  }

  async objectExists(objectName: string) {
    const [exists] = await this.bucket.file(`${this.keyPrefix}/${objectName}`).exists()
    return exists
  }

  async deleteFolder(folderName: string) {
    const prefix = `${this.keyPrefix}/${folderName}/`
    const [files] = await this.bucket.getFiles({ prefix, autoPaginate: true })
    await this.bucket.deleteFiles({ prefix })
    return {
      objects: files.length,
      bytes: files.reduce((total, file) => total + Number(file.metadata.size ?? 0), 0),
    }
  }

  async clear() {
    await this.bucket.deleteFiles({
      prefix: `${this.keyPrefix}/`,
    })
  }

  async uploadStream(objectName: string, iterator: AsyncIterable<Uint8Array>) {
    const file = this.bucket.file(`${this.keyPrefix}/${objectName}`)

    await pipeline(
      iterator,
      file.createWriteStream({
        resumable: false,
        validation: false,
      }),
    )
  }

  async countFilesInFolder(folderName: string) {
    return this.bucket
      .getFiles({
        prefix: `${this.keyPrefix}/${folderName}/`,
        autoPaginate: true,
      })
      .then((res) => res[0].length)
  }

  async getFolderSize(folderName: string) {
    const [files] = await this.bucket.getFiles({
      prefix: `${this.keyPrefix}/${folderName}/`,
      autoPaginate: true,
    })
    return files.reduce((total, file) => total + Number(file.metadata.size ?? 0), 0)
  }

  async listStorageFolders() {
    const [files] = await this.bucket.getFiles({
      prefix: `${this.keyPrefix}/`,
      autoPaginate: true,
    })
    const folders = new Map<string, StorageFolder>()
    const prefix = `${this.keyPrefix}/`

    for (const file of files) {
      const folderName = file.name.slice(prefix.length).split('/', 1)[0]
      if (!folderName) continue
      const updatedAt = Date.parse(file.metadata.updated ?? '')
      if (!Number.isFinite(updatedAt))
        throw new Error(`GCS did not return a modification time for object "${file.name}"`)
      accumulateFolder(folders, folderName, Number(file.metadata.size ?? 0), updatedAt)
    }

    return [...folders.values()]
  }

  async createDownloadUrl(objectName: string, expiresAt: number) {
    return this.bucket
      .file(`${this.keyPrefix}/${objectName}`)
      .getSignedUrl({
        action: 'read',
        expires: expiresAt,
      })
      .then((res) => res[0])
  }
}

class AzBlobAdapter implements StorageAdapter {
  static async fromEnv(env: Extract<Env, { STORAGE_DRIVER: 'azblob' }>) {
    const account = env.STORAGE_AZBLOB_ACCOUNT
    const accountUrl = `https://${account}.blob.core.windows.net`
    const container = env.STORAGE_AZBLOB_CONTAINER

    const client = new BlobServiceClient(accountUrl, new DefaultAzureCredential())
    const containerClient = client.getContainerClient(container)
    await containerClient.createIfNotExists()

    return new AzBlobAdapter({
      client,
      account,
      container,
    })
  }

  private client
  private account
  private container
  private keyPrefix = 'gh-actions-cache'

  constructor({
    client,
    account,
    container,
  }: {
    client: BlobServiceClient
    account: string
    container: string
  }) {
    this.client = client
    this.account = account
    this.container = container
  }

  private get containerClient() {
    return this.client.getContainerClient(this.container)
  }

  private blobKey(objectName: string) {
    return `${this.keyPrefix}/${objectName}`
  }

  async createDownloadStream(objectName: string): Promise<Readable> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(this.blobKey(objectName))
    const response = await blockBlobClient.download()
    if (!response.readableStreamBody) throw new Error(`No stream for blob "${objectName}"`)
    // Casting from NodeJS.ReadableStream to Readable
    return response.readableStreamBody as Readable
  }

  async uploadStream(objectName: string, stream: AsyncIterable<Uint8Array>): Promise<void> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(this.blobKey(objectName))
    // TODO: consider blockSize / concurrency tuning similar to S3Upload options
    await blockBlobClient.uploadStream(Readable.from(stream))
  }

  async objectExists(objectName: string): Promise<boolean> {
    return this.containerClient.getBlobClient(this.blobKey(objectName)).exists()
  }

  async deleteFolder(folderName: string): Promise<StorageDeletion> {
    const deleted = { objects: 0, bytes: 0 }
    const blobs = this.containerClient.listBlobsFlat({
      prefix: this.blobKey(folderName),
    })
    for await (const blob of blobs) {
      deleted.objects++
      deleted.bytes += blob.properties.contentLength ?? 0
      await this.containerClient.deleteBlob(blob.name)
    }
    return deleted
  }

  async clear(): Promise<void> {
    const blobs = this.containerClient.listBlobsFlat({ prefix: this.blobKey('') })
    for await (const blob of blobs) {
      await this.containerClient.deleteBlob(blob.name)
    }
  }

  async countFilesInFolder(folderName: string): Promise<number> {
    let count = 0
    const blobs = this.containerClient.listBlobsFlat({ prefix: this.blobKey(folderName) })
    for await (const _ of blobs) {
      count++
    }
    return count
  }

  async getFolderSize(folderName: string): Promise<number> {
    const blobs = this.containerClient.listBlobsFlat({
      prefix: this.blobKey(folderName),
    })
    let size = 0
    for await (const blob of blobs) {
      size += blob.properties.contentLength ?? 0
    }
    return size
  }

  async listStorageFolders(): Promise<StorageFolder[]> {
    const folders = new Map<string, StorageFolder>()
    const prefix = this.blobKey('')

    const blobs = this.containerClient.listBlobsFlat({ prefix })
    for await (const blob of blobs) {
      const relativeName = blob.name.slice(prefix.length)
      const folderName = relativeName.split('/', 1)[0]
      if (!folderName) continue

      const size = blob.properties.contentLength ?? 0
      const updatedAt = blob.properties.lastModified?.getTime() ?? 0
      accumulateFolder(folders, folderName, size, updatedAt)
    }

    return [...folders.values()]
  }

  async createDownloadUrl(objectName: string, expiresAt: number): Promise<string> {
    const startsOn = new Date()
    const expiresOn = new Date(expiresAt)

    const delegationKey = await this.client.getUserDelegationKey(startsOn, expiresOn)

    const sasParams = generateBlobSASQueryParameters(
      {
        containerName: this.container,
        blobName: this.blobKey(objectName),
        permissions: BlobSASPermissions.parse('r'),
        startsOn,
        expiresOn,
      },
      delegationKey,
      this.account,
    )

    return `https://${this.account}.blob.core.windows.net/${this.container}/${this.blobKey(objectName)}?${sasParams.toString()}`
  }
}
