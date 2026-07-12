import type { BackendConfig, SyncFetcher } from '../types.js'

export interface CreateFetcherOptions {
  backend: BackendConfig
  responseBytes: number
  poolSize?: number
}

const isNode =
  typeof process !== 'undefined' &&
  typeof process.versions?.node === 'string' &&
  // Electron renderer / browser-like environments provide `window`.
  typeof (globalThis as { window?: unknown }).window === 'undefined'

/**
 * Create the synchronous fetcher appropriate for the current runtime:
 * - Node: persistent worker-thread pool bridged with SharedArrayBuffer.
 * - Browser (inside a Web Worker): synchronous XMLHttpRequest.
 */
export async function createSyncFetcher(
  options: CreateFetcherOptions,
): Promise<SyncFetcher> {
  if (isNode) {
    const { createNodeFetcher } = await import('./node.js')
    return createNodeFetcher(options)
  }
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
    throw new Error(
      'pglite-httpfs requires a worker context in the browser: ' +
        'run PGlite inside a Web Worker (synchronous XHR is not available ' +
        'on the main thread)',
    )
  }
  if (options.backend.type !== 'http') {
    throw new Error(
      `pglite-httpfs: the '${options.backend.type}' backend requires Node; ` +
        'in browsers use the http backend (serve the bucket over HTTP or ' +
        'use a presigned base URL)',
    )
  }
  const { createBrowserFetcher } = await import('./browser.js')
  return createBrowserFetcher(options.backend)
}
