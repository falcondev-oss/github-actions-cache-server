/* eslint-disable no-shadow */
/* eslint-disable ts/method-signature-style */
import type { Kysely } from 'kysely'
import type { ReadableStream, WritableStream } from 'node:stream/web'
import type { Database, StorageLocation } from './db'
import type { Env } from './schemas'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { TransformStream } from 'node:stream/web'
import { createSingletonPromise } from '@antfu/utils'
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload as S3Upload } from '@aws-sdk/lib-storage'
import { Storage as GcsClient } from '@google-cloud/storage'
import { chunk } from 'remeda'
import { match } from 'ts-pattern'
import { getDatabase } from './db'
import { env } from './env'

class Storage {
  adapter
  private db

  private constructor({ db, adapter }: { adapter: StorageAdapter; db: Kysely<Database> }) {
    this.adapter = adapter
    this.db = db
  }

  static async fromEnv() {
    return new Storage({
      adapter: await match(env)
        .with({ STORAGE_DRIVER: 's3' }, S3Adapter.fromEnv)
        .with({ STORAGE_DRIVER: 'filesystem' }, FileSystemAdapter.fromEnv)
        .with({ STORAGE_DRIVER: 'gcs' }, GcsAdapter.fromEnv)
        .exhaustive(),
      db: await getDatabase(),
    })
  }

  async uploadPart(uploadId: string, partIndex: number, stream: ReadableStream) {
    const upload = await this.db
      .selectFrom('uploads')
      .where('id', '=', uploadId)
      .select(['folderName'])
      .executeTakeFirst()
    if (!upload) return

    await this.adapter.uploadStream(`${upload.folderName}/parts/${partIndex}`, stream)

    void this.db
      .updateTable('uploads')
      .set({
        lastPartUploadedAt: Date.now(),
      })
      .where('id', '=', uploadId)
      .execute()
  }

  async completeUpload(key: string, version: string) {
    const upload = await this.db
      .selectFrom('uploads')
      .where('key', '=', key)
      .where('version', '=', version)
      .selectAll()
      .executeTakeFirst()
    if (!upload) return

    const partCount = await this.adapter.countFilesInFolder(`${upload.folderName}/parts`)
    if (!partCount) throw new Error('No parts found for upload')

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
        .innerJoin('storage_locations', 'storage_locations.id', 'cache_entries.locationId')
        .select(['cache_entries.id', 'cache_entries.locationId', 'storage_locations.folderName'])
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
        await tx
          .deleteFrom('storage_locations')
          .where('id', '=', existingCacheEntry.locationId)
          .execute()
        await this.adapter.deleteFolder(existingCacheEntry.folderName)
      } else
        await tx
          .insertInto('cache_entries')
          .values({
            key: upload.key,
            version: upload.version,
            id: randomUUID(),
            updatedAt: Date.now(),
            locationId,
          })
          .execute()

      await tx.deleteFrom('uploads').where('id', '=', upload.id).execute()
    })

    return upload
  }

  async download(cacheEntryId: string) {
    const storageLocation = await this.db
      .selectFrom('storage_locations')
      .innerJoin('cache_entries', 'cache_entries.locationId', 'storage_locations.id')
      .where('cache_entries.id', '=', cacheEntryId)
      .selectAll('storage_locations')
      .executeTakeFirst()
    if (!storageLocation) return

    void this.db
      .updateTable('storage_locations')
      .set({
        lastDownloadedAt: Date.now(),
      })
      .where('id', '=', storageLocation.id)
      .execute()

    if (storageLocation.mergedAt || storageLocation.mergeStartedAt)
      return this.downloadFromCacheEntryLocation(storageLocation)

    await this.db
      .updateTable('storage_locations')
      .set({
        mergeStartedAt: Date.now(),
      })
      .where('id', '=', storageLocation.id)
      .execute()

    const { writable, readable } = new TransformStream()
    const [uploadStream, responseStream] = readable.tee()

    try {
      this.adapter
        .uploadStream(`${storageLocation.folderName}/merged`, uploadStream)
        .then(async () => {
          await this.db
            .updateTable('storage_locations')
            .set({
              mergedAt: Date.now(),
            })
            .where('id', '=', storageLocation.id)
            .execute()
          await this.db.transaction().execute(async (tx) => {
            await tx
              .updateTable('storage_locations')
              .set({
                partsDeletedAt: Date.now(),
              })
              .where('id', '=', storageLocation.id)
              .execute()
            await this.adapter.deleteFolder(`${storageLocation.folderName}/parts`)
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
            .execute()
        })

      this.feedPartsToWritable(storageLocation, writable)
    } catch (err) {
      await this.db
        .updateTable('storage_locations')
        .set({
          mergedAt: null,
          mergeStartedAt: null,
        })
        .where('id', '=', storageLocation.id)
        .execute()
      throw err
    }

    return responseStream
  }

  private async downloadFromCacheEntryLocation(location: StorageLocation) {
    if (location.mergedAt) return this.adapter.createDownloadStream(`${location.folderName}/merged`)

    const { writable, readable } = new TransformStream()
    this.feedPartsToWritable(location, writable)

    return readable
  }

  async feedPartsToWritable(location: StorageLocation, writable: WritableStream) {
    if (location.partsDeletedAt) throw new Error('No parts to feed for location with deleted parts')

    try {
      for (let i = 0; i < location.partCount; i++) {
        const partStream = await this.adapter.createDownloadStream(
          `${location.folderName}/parts/${i}`,
        )
        await partStream.pipeTo(writable, { preventClose: true })
      }

      await writable.close()
    } catch (err) {
      await writable.abort(err)
    }
  }

  async createUpload(key: string, version: string) {
    const existingUpload = await this.db
      .selectFrom('uploads')
      .where('key', '=', key)
      .where('version', '=', version)
      .select('id')
      .executeTakeFirst()
    if (existingUpload) return

    const uploadId = randomUUID()
    await this.db
      .insertInto('uploads')
      .values({
        id: uploadId,
        folderName: uploadId,
        createdAt: Date.now(),
        key,
        version,
        lastPartUploadedAt: null,
      })
      .execute()

    return { id: uploadId }
  }

  async getCacheEntry({
    keys: [primaryKey, ...restoreKeys],
    version,
  }: {
    keys: [string, ...string[]]
    version: string
  }) {
    const exactPrimaryMatch = await this.db
      .selectFrom('cache_entries')
      .where('key', '=', primaryKey)
      .where('version', '=', version)
      .selectAll()
      .executeTakeFirst()
    if (exactPrimaryMatch) return exactPrimaryMatch

    const prefixedPrimaryMatch = await this.db
      .selectFrom('cache_entries')
      .where('key', 'like', `${primaryKey}%`)
      .where('version', '=', version)
      .orderBy('cache_entries.updatedAt', 'desc')
      .selectAll()
      .executeTakeFirst()

    if (prefixedPrimaryMatch) return prefixedPrimaryMatch

    if (restoreKeys.length === 0) return

    for (const key of restoreKeys) {
      const exactMatch = await this.db
        .selectFrom('cache_entries')
        .where('key', '=', key)
        .where('version', '=', version)
        .orderBy('updatedAt', 'desc')
        .selectAll()
        .executeTakeFirst()
      if (exactMatch) return exactMatch

      const prefixedMatch = await this.db
        .selectFrom('cache_entries')
        .where('key', 'like', `${key}%`)
        .where('version', '=', version)
        .orderBy('updatedAt', 'desc')
        .selectAll()
        .executeTakeFirst()

      if (prefixedMatch) return prefixedMatch
    }
  }
}

export const getStorage = createSingletonPromise(async () => Storage.fromEnv())

interface StorageAdapter {
  createDownloadStream(objectName: string): Promise<ReadableStream>
  uploadStream(objectName: string, stream: ReadableStream): Promise<void>
  deleteFolder(folderName: string): Promise<void>
  countFilesInFolder(folderName: string): Promise<number>
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
    const s3 = new S3Client({
      forcePathStyle: true,
      region: env.AWS_REGION,
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
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: `${this.keyPrefix}/${objectName}`,
      }),
    )
    if (!response.Body) throw new Error('No body in S3 get object response')

    return response.Body.transformToWebStream() as ReadableStream
  }

  async deleteFolder(folderName: string) {
    const listResponse = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${this.keyPrefix}/${folderName}/`,
      }),
    )

    if (!listResponse.Contents || listResponse.Contents.length === 0) return

    await Promise.all(
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
  }

  async uploadStream(objectName: string, stream: ReadableStream) {
    await new S3Upload({
      client: this.s3,
      params: {
        Bucket: this.bucket,
        Key: `${this.keyPrefix}/${objectName}`,
        Body: stream as globalThis.ReadableStream,
      },
    }).done()
  }

  async countFilesInFolder(folderName: string) {
    const listResponse = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${this.keyPrefix}/${folderName}/`,
      }),
    )

    return listResponse.KeyCount ?? 0
  }
}

class FileSystemAdapter implements StorageAdapter {
  private rootFolder

  constructor({ rootFolder }: { rootFolder: string }) {
    this.rootFolder = rootFolder
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
    return Readable.toWeb(createReadStream(path.join(this.rootFolder, objectName)))
  }

  async deleteFolder(folderName: string) {
    await fs.rm(path.join(this.rootFolder, folderName), {
      recursive: true,
      force: true,
    })
  }

  async uploadStream(objectName: string, stream: ReadableStream) {
    const filePath = path.join(this.rootFolder, objectName)
    await fs.mkdir(path.dirname(filePath), {
      recursive: true,
    })
    await fs.writeFile(filePath, Readable.fromWeb(stream))
  }

  async countFilesInFolder(folderName: string) {
    const dir = await fs.readdir(path.join(this.rootFolder, folderName), {
      withFileTypes: true,
    })

    return dir.filter((item) => item.isFile()).length
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
    const stream = this.bucket.file(`${this.keyPrefix}/${objectName}`).createReadStream()
    return Readable.toWeb(stream)
  }

  async deleteFolder(folderName: string) {
    await this.bucket.deleteFiles({
      prefix: `${this.keyPrefix}/${folderName}/`,
    })
  }

  async uploadStream(objectName: string, stream: ReadableStream) {
    await this.bucket.file(`${this.keyPrefix}/${objectName}`).save(stream)
  }

  async countFilesInFolder(folderName: string) {
    return this.bucket
      .getFiles({
        prefix: `${this.keyPrefix}/${folderName}/`,
        autoPaginate: true,
      })
      .then((res) => res[0].length)
  }
}
