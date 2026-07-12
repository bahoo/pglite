import { defineConfig } from 'tsup'

// worker.ts must stay a separate emitted file: the Node sync-fetch bridge
// resolves it at runtime with `new URL('./worker.js', import.meta.url)`.
const entryPoints = [
  'src/index.ts',
  'src/manifest-node.ts',
  'src/worker.ts',
]

export default defineConfig({
  entry: entryPoints,
  sourcemap: true,
  dts: {
    entry: entryPoints,
    resolve: true,
  },
  clean: true,
  shims: true,
  format: ['esm', 'cjs'],
  external: ['@electric-sql/pglite', '@aws-sdk/client-s3'],
})
