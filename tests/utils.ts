import ky from 'ky'

export const cacheApi = ky.extend({
  prefixUrl: 'http://localhost:3000/_apis/artifactcache',
  throwHttpErrors: false,
})

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
