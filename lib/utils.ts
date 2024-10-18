import { hash } from 'node:crypto'

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
