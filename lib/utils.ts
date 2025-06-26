import { hash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ENV } from './env'

export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }

  return Buffer.concat(chunks)
}

export function getObjectNameFromKey(key: string, version: string) {
  return hash('sha1', Buffer.from(`${key}-${version}`))
}

export function createTempDir() {
  return fs.mkdtemp(path.join(ENV.TEMP_DIR, 'github-actions-cache-server'))
}
