import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    dir: 'tests',
    fileParallelism: false,
    maxConcurrency: 5,
    alias: {
      '~': import.meta.dirname,
    },
    globalSetup: './tests/setup.ts',
  },
})
