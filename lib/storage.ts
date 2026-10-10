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
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCopyCommand,
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
      // an unreleased lease only delays cleanup until it expires
      releaseReaderLease(this.db, readerLeaseId).catch((err) =>
        logger.warn(`Failed to release Storage Reader Lease ${readerLeaseId}`, { error: err }),
      )
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

  /**
   * Runs a Merge under a Merge Lease. `write` produces `${folderName}/merged`;
   * a lease-fenced transaction then marks the Merge complete. Returns false
   * when another worker holds the lease. Writing straight to the final object
   * is safe (ADR-0004). The returned promise never rejects: failures are logged
   * and the merge state rolled back.
   */
  private async startMerge(location: StorageLocation, write: () => Promise<void>) {
    const mergeToken = await acquireMergeLease(this.db, location.id)
    if (!mergeToken) return false

    await this.db
      .updateTable('storage_locations')
      .set({ mergeStartedAt: Date.now() })
      .where('id', '=', location.id)
      .execute()

    const renewalTimer = setInterval(() => {
      void renewMergeLease(this.db, location.id, mergeToken)
    }, LEASE_RENEWAL_MS)
    renewalTimer.unref()

    const mergePromise = write()
      .then(async () => {
        // The merged object is already written, so losing a deadlock here must
        // not throw the merge away — the fence is re-checked on every attempt.
        await retryOnLockConflict(() =>
          this.db.transaction().execute(async (tx) => {
            let leaseQuery = tx
              .selectFrom('merge_leases')
              .select(['token', 'expiresAt'])
              .where('storageLocationId', '=', location.id)
            if (env.DB_DRIVER !== 'sqlite') leaseQuery = leaseQuery.forUpdate()
            const lease = await leaseQuery.executeTakeFirst()
            if (lease?.token !== mergeToken || lease.expiresAt <= Date.now())
              throw new Error('Merge lease was lost before completion')
            await tx
              .updateTable('storage_locations')
              .set({ mergedAt: Date.now() })
              .where('id', '=', location.id)
              .execute()
          }),
        )
      })
      .catch(async (err) => {
        logger.error(`Merge failed for storage location ${location.id}`, { error: err })
        await this.db
          .updateTable('storage_locations')
          .set({ mergedAt: null, mergeStartedAt: null })
          .where('id', '=', location.id)
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
      })
      .finally(async () => {
        clearInterval(renewalTimer)
        await releaseMergeLease(this.db, location.id, mergeToken)
      })
    this.mergeStreamPromises.add(mergePromise)
    mergePromise.finally(() => this.mergeStreamPromises.delete(mergePromise))
    return true
  }

  /**
   * Eager Merge (ADR-0009): a Server-side Merge when the adapter can compose
   * these Parts, otherwise the streaming merge right away. Only the lease
   * acquisition is awaited; the Merge itself runs in the background.
   */
  private async mergeEagerly(location: StorageLocation, partSizes: number[]) {
    const compose = this.adapter.composeParts
    const composable =
      compose &&
      partSizes.length <= compose.maxParts &&
      partSizes.every(
        (bytes, index) =>
          bytes <= compose.maxPartBytes &&
          (index === partSizes.length - 1 || bytes >= compose.minPartBytes),
      )
    await this.startMerge(location, () =>
      composable
        ? compose.run(location.folderName, location.partCount)
        : this.adapter.uploadStream(
            `${location.folderName}/merged`,
            Readable.from(this.streamParts(location)),
          ),
    )
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

    const parts = await this.adapter.listFolder(`${upload.folderName}/parts`)
    const partCount = parts.length
    if (partCount !== upload.finishedPartUploadCount) {
      return this.abandonUpload(
        upload.id,
        upload.folderName,
        new Error(
          `Uploaded part count does not match actual part count in storage (expected ${upload.finishedPartUploadCount} but found ${partCount})`,
        ),
      )
    }

    const partSizes = parts
      .toSorted((a, b) => Number(a.name) - Number(b.name))
      .map(({ bytes }) => bytes)
    const location: StorageLocation = {
      id: randomUUID(),
      folderName: upload.folderName,
      partCount,
      mergedAt: null,
      mergeStartedAt: null,
      partsDeletedAt: null,
      lastDownloadedAt: null,
      sizeBytes: parts.reduce((sum, { bytes }) => sum + bytes, 0),
    }

    await this.db.transaction().execute(async (tx) => {
      await tx.insertInto('storage_locations').values(location).execute()

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
            locationId: location.id,
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
            locationId: location.id,
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

    if (env.EAGER_MERGE) {
      try {
        await this.mergeEagerly(location, partSizes)
      } catch (err) {
        logger.warn('Eager Merge failed to start after upload completion', { error: err })
      }
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

      const responseStream = new PassThrough()
      const mergerStream = new PassThrough()
      const merge = await this.startMerge(storageLocation, () =>
        this.adapter
          .uploadStream(`${storageLocation.folderName}/merged`, mergerStream)
          .catch((err) => {
            mergerStream.destroy()
            throw err
          }),
      )
      if (!merge) {
        const stream = await this.downloadFromCacheEntryLocation(storageLocation)
        return this.protectDownloadStream(stream, readerLeaseId)
      }

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
  /** Objects under a folder, names relative to it. */
  listFolder(folderName: string): Promise<StorageObject[]>
  listStorageFolders(): Promise<StorageFolder[]>
  createDownloadUrl?(objectName: string, expiresAt: number): Promise<string>
  getFilesystemUsage?(): Promise<{ capacityBytes: number; usedBytes: number }>
  /**
   * Server-side Merge: copies `${folderName}/parts/0..partCount-1` into
   * `${folderName}/merged` inside the backend. Only applicable when every Part
   * satisfies the limits; the caller checks them before calling `run`.
   */
  composeParts?: {
    /** Every Part but the last must be at least this large. */
    minPartBytes: number
    maxPartBytes: number
    maxParts: number
    run(folderName: string, partCount: number): Promise<void>
  }
  clear(): Promise<void>
}

export interface StorageObject {
  name: string
  bytes: number
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

  // S3 multipart limits: https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
  composeParts = {
    minPartBytes: 5 * 1024 * 1024,
    maxPartBytes: 5 * 1024 ** 3,
    maxParts: 10_000,
    run: async (folderName: string, partCount: number) => {
      const Bucket = this.bucket
      const Key = `${this.keyPrefix}/${folderName}/merged`
      const { UploadId } = await this.s3.send(new CreateMultipartUploadCommand({ Bucket, Key }))
      if (!UploadId) throw new Error('S3 did not return an UploadId')
      try {
        const Parts = []
        for (let PartNumber = 1; PartNumber <= partCount; PartNumber++) {
          const copy = await this.s3.send(
            new UploadPartCopyCommand({
              Bucket,
              Key,
              UploadId,
              PartNumber,
              CopySource: `${Bucket}/${this.keyPrefix}/${folderName}/parts/${PartNumber - 1}`,
            }),
          )
          Parts.push({ PartNumber, ETag: copy.CopyPartResult?.ETag })
        }
        await this.s3.send(
          new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts } }),
        )
      } catch (err) {
        await this.s3
          .send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }))
          .catch(() => {})
        throw err
      }
    },
  }

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

  async listFolder(folderName: string) {
    const prefix = `${this.keyPrefix}/${folderName}/`
    const objects: StorageObject[] = []
    for await (const page of this.listObjectsByPrefix(prefix)) {
      const contents = page.Contents ?? []
      for (const object of contents)
        if (object.Key)
          objects.push({ name: object.Key.slice(prefix.length), bytes: object.Size ?? 0 })
    }
    return objects
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

  async listFolder(folderName: string) {
    const folderPath = this.safePath(folderName)
    let entries
    try {
      entries = await fs.readdir(folderPath, { withFileTypes: true })
    } catch (err: any) {
      if (err.code === 'ENOENT') return []
      throw err
    }
    const files = entries.filter((entry) => entry.isFile())
    return Promise.all(
      files.map(async (entry) => {
        const stat = await fs.stat(path.join(folderPath, entry.name))
        return { name: entry.name, bytes: stat.size }
      }),
    )
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

  // GCS compose takes at most 32 sources per call and has no minimum size:
  // https://cloud.google.com/storage/docs/composing-objects
  composeParts = {
    minPartBytes: 0,
    maxPartBytes: 5 * 1024 ** 4,
    maxParts: Infinity,
    run: async (folderName: string, partCount: number) => {
      const sources = Array.from({ length: partCount }, (_, index) =>
        this.bucket.file(`${this.keyPrefix}/${folderName}/parts/${index}`),
      )
      // Folds batches into a top-level temp object (reclaimed as Orphaned
      // Storage if we crash) so `merged` only ever appears in one final,
      // atomic compose (ADR-0004).
      const temp = this.bucket.file(`${this.keyPrefix}/tmp-${randomUUID()}`)
      try {
        while (sources.length > 32) {
          await this.bucket.combine(sources.splice(0, 32), temp)
          sources.unshift(temp)
        }
        await this.bucket.combine(
          sources,
          this.bucket.file(`${this.keyPrefix}/${folderName}/merged`),
        )
      } finally {
        if (partCount > 32) await temp.delete({ ignoreNotFound: true })
      }
    },
  }

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

  async listFolder(folderName: string) {
    const prefix = `${this.keyPrefix}/${folderName}/`
    const [files] = await this.bucket.getFiles({ prefix, autoPaginate: true })
    return files.map((file) => ({
      name: file.name.slice(prefix.length),
      bytes: Number(file.metadata.size ?? 0),
    }))
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
    const container = env.STORAGE_AZBLOB_CONTAINER

    const usesSharedKey = Boolean(env.STORAGE_AZBLOB_CONNECTION_STRING)
    const client = env.STORAGE_AZBLOB_CONNECTION_STRING
      ? BlobServiceClient.fromConnectionString(env.STORAGE_AZBLOB_CONNECTION_STRING)
      : new BlobServiceClient(
          env.STORAGE_AZBLOB_ENDPOINT ??
            `https://${env.STORAGE_AZBLOB_ACCOUNT}.blob.core.windows.net`,
          new DefaultAzureCredential(),
        )

    const containerClient = client.getContainerClient(container)
    await containerClient.createIfNotExists()

    return new AzBlobAdapter({
      client,
      account: client.accountName,
      container,
      usesSharedKey,
    })
  }

  private client
  private account
  private container
  private usesSharedKey
  private keyPrefix = 'gh-actions-cache'

  constructor({
    client,
    account,
    container,
    usesSharedKey,
  }: {
    client: BlobServiceClient
    account: string
    container: string
    usesSharedKey: boolean
  }) {
    this.client = client
    this.account = account
    this.container = container
    this.usesSharedKey = usesSharedKey
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
    return Readable.from(response.readableStreamBody)
  }

  async uploadStream(objectName: string, stream: AsyncIterable<Uint8Array>): Promise<void> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(this.blobKey(objectName))
    // TODO: consider blockSize / concurrency tuning similar to S3Upload options
    await blockBlobClient.uploadStream(Readable.from(stream))
  }

  async objectExists(objectName: string): Promise<boolean> {
    return this.containerClient.getBlobClient(this.blobKey(objectName)).exists()
  }

  async deleteByPrefix(prefix: string): Promise<StorageDeletion> {
    // Azure caps a batch at 256 subrequests - align LIST paging with that so each page = one batch.
    const BATCH_SIZE = 256
    const deleted = { objects: 0, bytes: 0 }
    const batchClient = this.containerClient.getBlobBatchClient()

    const pages = this.containerClient.listBlobsFlat({ prefix }).byPage({ maxPageSize: BATCH_SIZE })

    for await (const page of pages) {
      const blobs = page.segment.blobItems
      if (blobs.length === 0) continue

      const clients = blobs.map((blob) => {
        deleted.objects += 1
        deleted.bytes += blob.properties.contentLength ?? 0
        return this.containerClient.getBlobClient(blob.name)
      })

      await batchClient.deleteBlobs(clients)
    }

    return deleted
  }

  async deleteFolder(folderName: string): Promise<StorageDeletion> {
    return this.deleteByPrefix(`${this.blobKey(folderName)}/`)
  }

  async clear(): Promise<void> {
    await this.deleteByPrefix(this.blobKey(''))
  }

  async countFilesInFolder(folderName: string): Promise<number> {
    let count = 0
    const blobs = this.containerClient.listBlobsFlat({
      prefix: `${this.blobKey(folderName)}/`,
    })
    for await (const _ of blobs) {
      count++
    }
    return count
  }

  async getFolderSize(folderName: string): Promise<number> {
    const blobs = this.containerClient.listBlobsFlat({
      prefix: `${this.blobKey(folderName)}/`,
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
    // Backdate start by 5 minutes so clock skew doesn't cause "not yet valid" rejections.
    const CLOCK_SKEW_MS = 5 * 60 * 1000
    const startsOn = new Date(Date.now() - CLOCK_SKEW_MS)
    const expiresOn = new Date(expiresAt)
    const permissions = BlobSASPermissions.parse('r')
    const blobClient = this.containerClient.getBlobClient(this.blobKey(objectName))

    // Shared-key connection strings can't request a user delegation key
    // (that requires Entra ID), so sign directly against the shared key.
    if (this.usesSharedKey) {
      return blobClient.generateSasUrl({ permissions, startsOn, expiresOn })
    }

    const delegationKey = await this.client.getUserDelegationKey(startsOn, expiresOn)
    const sasParams = generateBlobSASQueryParameters(
      {
        containerName: this.container,
        blobName: this.blobKey(objectName),
        permissions,
        startsOn,
        expiresOn,
      },
      delegationKey,
      this.account,
    )
    return `${blobClient.url}?${sasParams.toString()}`
  }
}
