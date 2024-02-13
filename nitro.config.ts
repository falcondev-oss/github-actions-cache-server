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
  },
  typescript: {
    strict: true,
    tsConfig: {
      compilerOptions: {
        skipLibCheck: true,
        paths: {
          '@/*': ['../../*'],
        },
      },
    },
  },
})
