import { fileURLToPath } from 'node:url'

import { version } from './package.json'

export default defineNitroConfig({
  preset: 'node-cluster',
  runtimeConfig: {
    version: `v${version}${process.env.BUILD_HASH ? ` [${process.env.BUILD_HASH}]` : ''}`,
  },
  alias: {
    '@': fileURLToPath(new URL('.', import.meta.url)),
  },
  typescript: {
    strict: true,
    tsConfig: {
      compilerOptions: {
        skipLibCheck: true,
      },
    },
  },
  compatibilityDate: '2025-02-01',
  experimental: {
    tasks: true,
  },
  scheduledTasks: {
    '*/5 * * * *': ['cleanup:uploads'], // every 5 minutes
    '0 0 * * *': ['cleanup:cache-entries', 'cleanup:storage-locations'], // daily
    '0 * * * *': ['cleanup:parts', 'cleanup:merges'], // hourly
  },
})
