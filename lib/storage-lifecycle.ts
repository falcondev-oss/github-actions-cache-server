import type { ExpressionBuilder, Kysely, Transaction } from 'kysely'
import type { Database, StorageReaderLeaseScope } from './db'
import type { StorageAdapter } from './storage'
import pLimit from 'p-limit'
import { env } from './env'
import { logger } from './logger'

export interface OrphanedStorageSummary {
  inspectedFolders: number
  authorizedFolders: number
  gracePeriodFolders: number
  deletedFolders: number
  deletedObjects: number
  deletedBytes: number
  failures: number
}

export class CleanupAggregateError<T = Record<string, unknown>> extends AggregateError {
  constructor(
    errors: unknown[],
    message: string,
    readonly summary: T,
  ) {
    super(errors, message)
    this.name = 'CleanupAggregateError'
  }
}

export async function runCleanupTask<T extends { durationMs: number; failures: number }>({
  task,
  result,
  run,
}: {
  task: string
  result: T
  run: () => Promise<void>
}) {
  const startedAt = Date.now()
  try {
    await run()
    result.durationMs = Date.now() - startedAt
    logger.info('Cleanup run completed', { task, ...result })
    return { result }
  } catch (err) {
    if (!(err instanceof CleanupAggregateError) || result.failures === 0) result.failures++
    result.durationMs = Date.now() - startedAt
    logger.info('Cleanup run completed', { task, ...result })
    logger.error('Cleanup run failed', { task, ...result, error: err })
    throw err
  }
}

async function lockStorageLocation(tx: Transaction<Database>, id: string) {
  let query = tx.selectFrom('storage_locations').select('id').where('id', '=', id)
  if (env.DB_DRIVER !== 'sqlite') query = query.forUpdate()
  return query.executeTakeFirst()
}

async function hasActiveReaderLease(
  tx: Transaction<Database>,
  storageLocationId: string,
  scope?: StorageReaderLeaseScope,
) {
  let query = tx
    .selectFrom('storage_reader_leases')
    .select('id')
    .where('storageLocationId', '=', storageLocationId)
    .where('expiresAt', '>', Date.now())
  if (scope) query = query.where('scope', '=', scope)
  return !!(await query.executeTakeFirst())
}

/**
 * Predicate for cleanup queries selecting from `storage_locations`: true when no
 * unexpired Storage Reader Lease (optionally scoped) protects the row.
 */
export function noActiveReaderLease(
  eb: ExpressionBuilder<Database, 'storage_locations'>,
  scope?: StorageReaderLeaseScope,
) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom('storage_reader_leases')
        .select('storage_reader_leases.id')
        .whereRef('storage_reader_leases.storageLocationId', '=', 'storage_locations.id')
        .$if(scope !== undefined, (qb) => qb.where('storage_reader_leases.scope', '=', scope!))
        .where('storage_reader_leases.expiresAt', '>', Date.now()),
    ),
  )
}

export async function deleteStorageLocationIfUnread(
  tx: Transaction<Database>,
  storageLocationId: string,
) {
  if (!(await lockStorageLocation(tx, storageLocationId))) return false
  if (await hasActiveReaderLease(tx, storageLocationId)) return false
  await tx.deleteFrom('storage_locations').where('id', '=', storageLocationId).execute()
  return true
}

export async function claimPartsDeletionIfUnread(
  tx: Transaction<Database>,
  storageLocationId: string,
) {
  if (!(await lockStorageLocation(tx, storageLocationId))) return false
  if (await hasActiveReaderLease(tx, storageLocationId, 'parts')) return false
  const updated = await tx
    .updateTable('storage_locations')
    .set({ partsDeletedAt: Date.now() })
    .where('id', '=', storageLocationId)
    .where('partsDeletedAt', 'is', null)
    .executeTakeFirst()
  return Number(updated.numUpdatedRows) === 1
}

export async function reconcileOrphanedStorage({
  db,
  adapter,
  gracePeriodHours,
  now = Date.now(),
}: {
  db: Kysely<Database>
  adapter: StorageAdapter
  gracePeriodHours: number
  now?: number
}): Promise<OrphanedStorageSummary> {
  // Inventory must complete before any deletion. A partial listing must never be
  // mistaken for evidence that an object is orphaned.
  const storedFolders = await adapter.listStorageFolders()
  const [locations, uploads] = await Promise.all([
    db.selectFrom('storage_locations').select('folderName').execute(),
    db.selectFrom('uploads').select('folderName').execute(),
  ])
  const authorizedFolders = new Set([
    ...locations.map(({ folderName }) => folderName),
    ...uploads.map(({ folderName }) => folderName),
  ])
  const cutoff = now - gracePeriodHours * 60 * 60 * 1000
  const orphaned = storedFolders.filter(
    ({ folderName, updatedAt }) => !authorizedFolders.has(folderName) && updatedAt <= cutoff,
  )
  const summary: OrphanedStorageSummary = {
    inspectedFolders: storedFolders.length,
    authorizedFolders: storedFolders.filter(({ folderName }) => authorizedFolders.has(folderName))
      .length,
    gracePeriodFolders: storedFolders.filter(
      ({ folderName, updatedAt }) => !authorizedFolders.has(folderName) && updatedAt > cutoff,
    ).length,
    deletedFolders: 0,
    deletedObjects: 0,
    deletedBytes: 0,
    failures: 0,
  }
  const errors: unknown[] = []
  const limit = pLimit(5)

  await Promise.all(
    orphaned.map((folder) =>
      limit(async () => {
        try {
          const deleted = await adapter.deleteFolder(folder.folderName)
          summary.deletedFolders++
          summary.deletedObjects += deleted.objects
          summary.deletedBytes += deleted.bytes
        } catch (err) {
          summary.failures++
          errors.push(err)
        }
      }),
    ),
  )

  if (errors.length > 0)
    throw new CleanupAggregateError(errors, 'Failed to delete orphaned storage', { ...summary })
  return summary
}
