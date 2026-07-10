import type { Kysely } from 'kysely'
import type { Database, StorageReaderLeaseScope } from './db'
import { randomUUID } from 'node:crypto'
import { env } from './env'

export const LEASE_DURATION_MS = 2 * 60 * 1000
export const LEASE_RENEWAL_MS = 30 * 1000
export const DIRECT_DOWNLOAD_LEASE_DURATION_MS = 10 * 60 * 1000

export async function acquireMergeLease(
  db: Kysely<Database>,
  storageLocationId: string,
  now = Date.now(),
) {
  const token = randomUUID()
  const updated = await db
    .updateTable('merge_leases')
    .set({ token, expiresAt: now + LEASE_DURATION_MS })
    .where('storageLocationId', '=', storageLocationId)
    .where('expiresAt', '<=', now)
    .executeTakeFirst()
  if (Number(updated.numUpdatedRows) === 1) return token

  const insert = db
    .insertInto('merge_leases')
    .values({ storageLocationId, token, expiresAt: now + LEASE_DURATION_MS })
  const result =
    env.DB_DRIVER === 'mysql'
      ? await insert.ignore().executeTakeFirst()
      : await insert
          .onConflict((conflict) => conflict.column('storageLocationId').doNothing())
          .executeTakeFirst()
  if (Number(result.numInsertedOrUpdatedRows) === 1) return token
}

export async function renewMergeLease(
  db: Kysely<Database>,
  storageLocationId: string,
  token: string,
) {
  const result = await db
    .updateTable('merge_leases')
    .set({ expiresAt: Date.now() + LEASE_DURATION_MS })
    .where('storageLocationId', '=', storageLocationId)
    .where('token', '=', token)
    .where('expiresAt', '>', Date.now())
    .executeTakeFirst()
  return Number(result.numUpdatedRows) === 1
}

export async function releaseMergeLease(
  db: Kysely<Database>,
  storageLocationId: string,
  token: string,
) {
  await db
    .deleteFrom('merge_leases')
    .where('storageLocationId', '=', storageLocationId)
    .where('token', '=', token)
    .execute()
}

export async function createReaderLease(
  db: Kysely<Database>,
  storageLocationId: string,
  scope: StorageReaderLeaseScope,
  expiresAt = Date.now() + LEASE_DURATION_MS,
) {
  const id = randomUUID()
  await db
    .insertInto('storage_reader_leases')
    .values({ id, storageLocationId, scope, expiresAt })
    .execute()
  return id
}

export async function renewReaderLease(db: Kysely<Database>, id: string) {
  const now = Date.now()
  const result = await db
    .updateTable('storage_reader_leases')
    .set({ expiresAt: now + LEASE_DURATION_MS })
    .where('id', '=', id)
    .where('expiresAt', '>', now)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) === 1
}

export async function releaseReaderLease(db: Kysely<Database>, id: string) {
  await db.deleteFrom('storage_reader_leases').where('id', '=', id).execute()
}
