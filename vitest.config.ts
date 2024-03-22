import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    dir: 'tests',
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
    globalSetup: './tests/setup.ts',
  },
})
