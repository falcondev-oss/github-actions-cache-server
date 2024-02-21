import Database from 'better-sqlite3'
import { and, desc, eq, like } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { CacheKeys } from '@/db/schema'

export const sqlite = new Database('data/sqlite.db')
export const db = drizzle(sqlite)

/**
 * @see https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#matching-a-cache-key
 */
export async function findKeyMatch(opts: { key: string; version: string; restoreKeys?: string[] }) {
  const exactPrimaryMatches = await db
    .select()
    .from(CacheKeys)
    .where(and(eq(CacheKeys.key, opts.key), eq(CacheKeys.version, opts.version)))
    .limit(1)
  if (exactPrimaryMatches.length > 0) {
    return exactPrimaryMatches[0]
  }

  if (!opts.restoreKeys) return

  for (const key of opts.restoreKeys) {
    const exactMatches = await db
      .select()
      .from(CacheKeys)
      .where(and(eq(CacheKeys.version, opts.version), eq(CacheKeys.key, key)))
      .orderBy(desc(CacheKeys.updatedAt))
      .limit(1)
    if (exactMatches.length > 0) {
      return exactMatches[0]
    }

    const prefixedMatches = await db
      .select()
      .from(CacheKeys)
      .where(and(eq(CacheKeys.version, opts.version), like(CacheKeys.key, `${key}%`)))
      .orderBy(desc(CacheKeys.updatedAt))
      .limit(1)
    if (prefixedMatches.length > 0) {
      return prefixedMatches[0]
    }
  }
}

export async function touchKey(key: string, version: string) {
  const now = new Date().toISOString()
  await db
    .update(CacheKeys)
    .set({ updatedAt: now })
    .where(and(eq(CacheKeys.key, key), eq(CacheKeys.version, version)))
}

export async function createKey(key: string, version: string) {
  const now = new Date().toISOString()
  await db.insert(CacheKeys).values({ key, version, updatedAt: now })
}
