import { fileURLToPath } from 'node:url'
export default defineNitroConfig({
  preset: 'node-server',
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
