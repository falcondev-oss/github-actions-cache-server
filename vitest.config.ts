import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    dir: 'tests',
    alias: {
      '@': import.meta.dirname,
    },
    globalSetup: './tests/setup.ts',
  },
})
