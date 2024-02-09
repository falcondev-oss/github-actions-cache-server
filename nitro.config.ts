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
  typescript: {
    strict: true,
    tsConfig: {
      compilerOptions: {
        skipLibCheck: true,
      },
    },
  },
})
