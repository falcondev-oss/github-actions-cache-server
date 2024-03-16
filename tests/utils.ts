import ky from 'ky'

export const downloadApi = ky.extend({
  prefixUrl: 'http://localhost:3000/test_token',
  throwHttpErrors: false,
})

export const cacheApi = ky.extend({
  prefixUrl: 'http://localhost:3000/test_token/_apis/artifactcache',
  throwHttpErrors: false,
})
