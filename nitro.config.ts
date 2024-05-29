import { fileURLToPath } from 'node:url'

import { version } from './package.json'

export default defineNitroConfig({
  preset: 'node-server',
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
    // https://github.com/unjs/consola/issues/276
    'consola': 'consola',
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
      exclude: ['../../docs'],
    },
  },
})
