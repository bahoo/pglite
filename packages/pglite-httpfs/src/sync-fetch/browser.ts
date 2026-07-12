/**
 * Browser sync-fetch: synchronous XMLHttpRequest. Only available inside a
 * Web Worker (browsers forbid sync XHR on the main thread — and PGlite in
 * the browser should be running in a worker anyway).
 *
 * Only the HTTP backend is supported in browsers; for S3, serve the bucket
 * over HTTP (public bucket, CloudFront, or presigned base URL).
 */

import type { HttpBackendConfig, SyncFetcher } from '../types.js'

export function createBrowserFetcher(backend: HttpBackendConfig): SyncFetcher {
  const base = backend.baseUrl.endsWith('/')
    ? backend.baseUrl.slice(0, -1)
    : backend.baseUrl

  return {
    fetchSync(path: string, start?: number, end?: number): Uint8Array {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', base + path, false)
      xhr.responseType = 'arraybuffer'
      for (const [name, value] of Object.entries(backend.headers ?? {})) {
        xhr.setRequestHeader(name, value)
      }
      if (start !== undefined && end !== undefined) {
        xhr.setRequestHeader('Range', `bytes=${start}-${end}`)
      }
      xhr.send(null)
      if (xhr.status !== 200 && xhr.status !== 206) {
        throw new Error(
          `pglite-httpfs: fetch failed for ${path}: HTTP ${xhr.status}`,
        )
      }
      return new Uint8Array(xhr.response as ArrayBuffer)
    },
    terminate() {},
  }
}
