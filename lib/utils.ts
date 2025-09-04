import type { CacheFileName } from './storage/storage-driver'
import { hash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ENV } from './env'

export function getCacheFileName(key: string, version: string) {
  return hash('sha1', Buffer.from(`${key}-${version}`)) as CacheFileName
}

export function createTempDir() {
  return fs.mkdtemp(path.join(ENV.TEMP_DIR, 'github-actions-cache-server'))
}
