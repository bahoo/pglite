import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'pglite-httpfs',
    globals: true,
    environment: 'node',
    testTimeout: 120000,
    watch: false,
    dir: './tests',
    fileParallelism: false,
  },
})
