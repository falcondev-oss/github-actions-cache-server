import { fileURLToPath } from 'node:url'

import { version } from './package.json'

export default defineNitroConfig({
  preset: 'node-cluster',
  runtimeConfig: {
    version: `v${version}${process.env.BUILD_HASH ? ` [${process.env.BUILD_HASH}]` : ''}`,
  },
  storage: {
    db: {
      driver: 'fs',
      base: './data/db',
    },
  },
  devStorage: {
    db: {
      driver: 'fs',
      base: './data/db',
    },
  },
  alias: {
    '@': fileURLToPath(new URL('.', import.meta.url)),
  },
  esbuild: {
    options: {
      target: 'esnext',
    },
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
})
