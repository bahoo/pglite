/**
 * HTTP backend — serves a PGlite data directory from any static file host
 * that supports Range requests (nginx, S3/CloudFront, Netlify, ...).
 *
 * Expects an `index.json` manifest at the root of the served directory.
 * Generate one with `generateManifest()` from
 * `@electric-sql/pglite-httpfs/manifest-node`, or:
 *
 *   cd datadir && find . -type f -printf '{"path":"/%P","size":%s}\n' \
 *     | jq -s . > index.json
 */

import type { HttpBackendConfig, ManifestInput } from '../types.js'
import { normalizeManifest } from '../manifest.js'
import type { Backend } from './backend.js'

export function createHttpBackend(config: HttpBackendConfig): Backend {
  const base = config.baseUrl.endsWith('/')
    ? config.baseUrl.slice(0, -1)
    : config.baseUrl

  return {
    async list() {
      const url = `${base}/index.json`
      const resp = await fetch(url, { headers: config.headers })
      if (!resp.ok) {
        throw new Error(
          `pglite-httpfs: failed to fetch manifest from ${url}: HTTP ${resp.status}`,
        )
      }
      return normalizeManifest((await resp.json()) as ManifestInput)
    },

    async fetch(path: string, start?: number, end?: number) {
      const headers: Record<string, string> = { ...config.headers }
      if (start !== undefined && end !== undefined) {
        headers['Range'] = `bytes=${start}-${end}`
      }
      const url = base + path
      const resp = await fetch(url, { headers })
      if (!resp.ok && resp.status !== 206) {
        throw new Error(
          `pglite-httpfs: fetch failed for ${url}: HTTP ${resp.status}`,
        )
      }
      return new Uint8Array(await resp.arrayBuffer())
    },
  }
}
