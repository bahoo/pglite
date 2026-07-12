import { RemoteFilesystem } from './remote-fs.js'
import type { FetchGranularity, RemoteFilesystemOptions } from './types.js'

export interface HttpFsOptions
  extends Omit<RemoteFilesystemOptions, 'backend'> {
  fetchGranularity?: FetchGranularity
  headers?: Record<string, string>
}

/**
 * Convenience wrapper for the common case of a data directory served over
 * HTTP, mirroring the API of the original HttpFs draft (PR #364):
 *
 * ```ts
 * const pg = await PGlite.create({
 *   fs: new HttpFs('https://example.com/pgdata', { fetchGranularity: 'page' }),
 * })
 * ```
 */
export class HttpFs extends RemoteFilesystem {
  constructor(baseUrl: string, options: HttpFsOptions = {}) {
    const { headers, ...rest } = options
    super({ ...rest, backend: { type: 'http', baseUrl, headers } })
  }
}
