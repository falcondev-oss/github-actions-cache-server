export * from './drivers/minio'

export function encodeCacheKey(key: string, version: string) {
  return encodeURIComponent(`${key}-${version}`)
}
