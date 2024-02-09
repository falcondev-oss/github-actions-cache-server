export function dbKeyFromKeyAndVersion(key: string, version: string | undefined) {
  return version ? `${key}:${version}` : key
}

export async function cacheIdFromKeyAndVersion(key: string, version: string | undefined) {
  const storage = useStorage('db')
  const dbKey = dbKeyFromKeyAndVersion(key, version)
  return storage.getItem<number>(dbKey)
}

export async function saveCacheId(key: string, version: string | undefined, cacheId: number) {
  const storage = useStorage('db')
  const dbKey = dbKeyFromKeyAndVersion(key, version)
  return storage.setItem(dbKey, cacheId)
}
