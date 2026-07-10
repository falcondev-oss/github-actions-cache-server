/* eslint-disable no-shadow */
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
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload as S3Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Storage as GcsClient } from '@google-cloud/storage'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { sql } from 'kysely'
import { chunk } from 'remeda'
import { match } from 'ts-pattern'
import { getDatabase } from './db'
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
  adapter
  private db
  private mergeStreamPromises = new Set<Promise<void>>()

  private constructor({ db, adapter }: { adapter: StorageAdapter; db: Kysely<Database> }) {
    this.adapter = adapter
    this.db = db
  }

  static async getAdapterFromEnv() {
    return await match(env)
      .with({ STORAGE_DRIVER: 's3' }, S3Adapter.fromEnv)
      .with({ STORAGE_DRIVER: 'filesystem' }, FileSystemAdapter.fromEnv)
      .with({ STORAGE_DRIVER: 'gcs' }, GcsAdapter.fromEnv)
      .exhaustive()
  }

  static async fromEnv() {
    return new Storage({
      adapter: await Storage.getAdapterFromEnv(),
      db: await getDatabase(),
    })
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

    return upload
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
      const mergeCandidateFolder = `merge-${mergeToken}`
      const mergeCandidateObject = `${mergeCandidateFolder}/merged`

      const mergePromise = this.adapter
        .uploadStream(mergeCandidateObject, mergerStream)
        .then(async () => {
          await this.db.transaction().execute(async (tx) => {
            let leaseQuery = tx
              .selectFrom('merge_leases')
              .select(['token', 'expiresAt'])
              .where('storageLocationId', '=', storageLocation.id)
            if (env.DB_DRIVER !== 'sqlite') leaseQuery = leaseQuery.forUpdate()
            const lease = await leaseQuery.executeTakeFirst()
            if (lease?.token !== mergeToken || lease.expiresAt <= Date.now())
              throw new Error('Merge lease was lost before completion')
            await this.adapter.promoteObject(
              mergeCandidateObject,
              `${storageLocation.folderName}/merged`,
            )
            await tx
              .updateTable('storage_locations')
              .set({ mergedAt: Date.now() })
              .where('id', '=', storageLocation.id)
              .execute()
          })
        })
        .catch(async () => {
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
          try {
            await this.adapter.deleteFolder(mergeCandidateFolder)
          } catch (err) {
            logger.warn('Failed to remove merge candidate storage', {
              folderName: mergeCandidateFolder,
              error: err,
            })
          }
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
      const responseWantsMore = responseStream.write(chunk)
      const mergerWantsMore = mergerStream.write(chunk)

      if (!responseWantsMore) await once(responseStream, 'drain')
      if (!mergerWantsMore) await once(mergerStream, 'drain')
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
    keys: [primaryKey, ...restoreKeys],
    version,
    scopes,
    repoId,
  }: {
    keys: [string, ...string[]]
    version: string
    scopes: string[]
    repoId: string
  }) {
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
    const cacheEntry = await this.matchCacheEntry(args)
    if (!cacheEntry) return

    const defaultUrl = `${env.API_BASE_URL}/download/${cacheEntry.match.id}`

    if (!env.ENABLE_DIRECT_DOWNLOADS || !this.adapter.createDownloadUrl)
      return {
        downloadUrl: defaultUrl,
        cacheEntry: cacheEntry.match,
      }

    const directDownloadExpiresAt = Date.now() + DIRECT_DOWNLOAD_LEASE_DURATION_MS
    const location = await this.db.transaction().execute(async (tx) => {
      let query = tx
        .selectFrom('storage_locations')
        .where('id', '=', cacheEntry.match.locationId)
        .select(['id', 'folderName', 'mergedAt'])
      if (env.DB_DRIVER !== 'sqlite') query = query.forUpdate()
      const location = await query.executeTakeFirst()
      if (!location?.mergedAt) return location
      await createReaderLease(tx, location.id, 'storage', directDownloadExpiresAt)
      await tx
        .updateTable('storage_locations')
        .set({ lastDownloadedAt: Date.now() })
        .where('id', '=', location.id)
        .execute()
      return location
    })
    if (!location) throw new Error('Storage location not found')

    let downloadUrl = defaultUrl
    if (location.mergedAt) {
      downloadUrl = await this.adapter.createDownloadUrl(
        `${location.folderName}/merged`,
        directDownloadExpiresAt,
      )
    }

    return {
      downloadUrl,
      cacheEntry: cacheEntry.match,
    }
  }
}

export const getStorage = createSingletonPromise(async () => Storage.fromEnv())

export interface StorageAdapter {
  createDownloadStream(objectName: string): Promise<Readable>
  uploadStream(objectName: string, stream: Readable): Promise<void>
  deleteFolder(folderName: string): Promise<StorageDeletion>
  countFilesInFolder(folderName: string): Promise<number>
  listStorageFolders(): Promise<StorageFolder[]>
  promoteObject(sourceObjectName: string, destinationObjectName: string): Promise<void>
  createDownloadUrl?(objectName: string, expiresAt: number): Promise<string>
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
  private s3
  private bucket
  private keyPrefix = 'gh-actions-cache'

  constructor({ bucket, s3 }: { s3: S3Client; bucket: string }) {
    this.s3 = s3
    this.bucket = bucket
  }

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

  async deleteFolder(folderName: string) {
    return this.deleteByPrefix(`${this.keyPrefix}/${folderName}/`)
  }

  async clear() {
    await this.deleteByPrefix(`${this.keyPrefix}/`)
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

  async promoteObject(sourceObjectName: string, destinationObjectName: string) {
    const sourceKey = `${this.keyPrefix}/${sourceObjectName}`
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: encodeURIComponent(`${this.bucket}/${sourceKey}`),
        Key: `${this.keyPrefix}/${destinationObjectName}`,
      }),
    )
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sourceKey }))
  }

  async countFilesInFolder(folderName: string) {
    let count = 0

    for await (const listResponse of this.listObjectsByPrefix(`${this.keyPrefix}/${folderName}/`))
      count += listResponse.Contents?.length ?? 0

    return count
  }

  async listStorageFolders() {
    const folders = new Map<string, StorageFolder>()
    const prefix = `${this.keyPrefix}/`

    for await (const response of this.listObjectsByPrefix(prefix)) {
      for (const object of response.Contents ?? []) {
        if (!object.Key) continue
        if (!object.LastModified)
          throw new Error(`S3 did not return a modification time for object "${object.Key}"`)
        const relativeName = object.Key.slice(prefix.length)
        const folderName = relativeName.split('/')[0]
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

  static async fromEnv(env: Extract<Env, { STORAGE_DRIVER: 'filesystem' }>) {
    const rootFolder = env.STORAGE_FILESYSTEM_PATH
    await fs.mkdir(rootFolder, {
      recursive: true,
    })

    return new FileSystemAdapter({
      rootFolder,
    })
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

  async uploadStream(objectName: string, stream: Readable) {
    const filePath = this.safePath(objectName)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await pipeline(stream, createWriteStream(filePath))
  }

  async promoteObject(sourceObjectName: string, destinationObjectName: string) {
    const destination = this.safePath(destinationObjectName)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rename(this.safePath(sourceObjectName), destination)
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

  async listStorageFolders() {
    const entries = await fs.readdir(this.rootFolder, { withFileTypes: true })
    const folders: StorageFolder[] = []
    for (const entry of entries)
      folders.push(await this.inspectPath(this.safePath(entry.name), entry.name))
    return folders
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
}

class GcsAdapter implements StorageAdapter {
  private bucket
  private keyPrefix = 'gh-actions-cache'

  constructor({ bucket, gcs }: { bucket: string; gcs: GcsClient }) {
    this.bucket = gcs.bucket(bucket)
  }

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

  async createDownloadStream(objectName: string) {
    const file = this.bucket.file(`${this.keyPrefix}/${objectName}`)
    const [exists] = await file.exists()
    if (!exists) throw new ObjectNotFoundError(objectName)
    return file.createReadStream()
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

  async promoteObject(sourceObjectName: string, destinationObjectName: string) {
    await this.bucket
      .file(`${this.keyPrefix}/${sourceObjectName}`)
      .move(this.bucket.file(`${this.keyPrefix}/${destinationObjectName}`))
  }

  async countFilesInFolder(folderName: string) {
    return this.bucket
      .getFiles({
        prefix: `${this.keyPrefix}/${folderName}/`,
        autoPaginate: true,
      })
      .then((res) => res[0].length)
  }

  async listStorageFolders() {
    const [files] = await this.bucket.getFiles({
      prefix: `${this.keyPrefix}/`,
      autoPaginate: true,
    })
    const folders = new Map<string, StorageFolder>()
    const prefix = `${this.keyPrefix}/`

    for (const file of files) {
      const folderName = file.name.slice(prefix.length).split('/')[0]
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
