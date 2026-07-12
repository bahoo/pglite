/**
 * Shared types for @electric-sql/pglite-httpfs.
 */

/** One entry in a remote data directory listing. */
export interface RemoteFileEntry {
  /** Path relative to the data directory root, with a leading slash. */
  path: string
  /** File size in bytes (-1 for directories). */
  size: number
  /** Set to 'dir' for directories; omitted for regular files. */
  type?: 'dir'
}

/**
 * Accepted manifest shapes:
 * - a plain array of RemoteFileEntry
 * - `{ files: [...] }` where entries may use `name` instead of `path`
 *   (the shape of the `index.json` produced by tar-index style tooling)
 */
export type ManifestInput =
  | RemoteFileEntry[]
  | {
      files: Array<{
        path?: string
        name?: string
        size: number
        type?: string
      }>
    }

/**
 * Configuration for the S3 backend. Must be structured-cloneable — it
 * crosses a postMessage boundary into the fetch worker.
 */
export interface S3BackendConfig {
  type: 's3'
  bucket: string
  /** Key prefix of the data directory within the bucket (e.g. "db/main/"). */
  prefix: string
  /**
   * Options passed to the AWS SDK `S3Client` constructor
   * (region, endpoint, credentials, forcePathStyle, ...).
   */
  clientConfig?: Record<string, unknown>
}

/** Configuration for the HTTP backend. */
export interface HttpBackendConfig {
  type: 'http'
  /** Base URL of the served data directory (e.g. "https://cdn.example.com/db"). */
  baseUrl: string
  /** Extra headers to send with every request (e.g. Authorization). */
  headers?: Record<string, string>
}

export type BackendConfig = S3BackendConfig | HttpBackendConfig

/**
 * How file contents are fetched:
 * - 'auto' (default): files up to `lazyThreshold` are fetched whole on
 *   first access; larger files are range-fetched in chunks of 8 KB pages.
 * - 'file': always fetch whole files.
 * - 'page': always range-fetch, regardless of size.
 */
export type FetchGranularity = 'auto' | 'file' | 'page'

export interface RemoteFilesystemOptions {
  /** Where the data directory lives. */
  backend: BackendConfig
  /**
   * Pre-supplied file listing. When omitted, the backend is asked for one:
   * the HTTP backend fetches `<baseUrl>/index.json`, the S3 backend tries
   * `<prefix>manifest.json` and falls back to a ListObjectsV2 walk.
   */
  manifest?: ManifestInput
  /** See {@link FetchGranularity}. Default: 'auto'. */
  fetchGranularity?: FetchGranularity
  /**
   * Size above which a file is range-fetched instead of downloaded whole
   * (only meaningful for 'auto'). Default: 64 MiB.
   */
  lazyThreshold?: number
  /**
   * Number of 8 KB Postgres pages fetched per range request on lazy files.
   * Default: 64 (512 KiB per request) — one request amortizes a run of
   * sequential page reads.
   */
  chunkPages?: number
  /**
   * Per-file page-cache cap for lazy files, in pages. Clean pages beyond
   * this are evicted (least recently used first); pages holding writes are
   * never evicted. Default: 4096 pages (32 MiB).
   */
  maxPagesPerFile?: number
  /**
   * Soft cap on total cached bytes across all files. When exceeded, clean
   * cached data is dropped (least recently used first) until usage falls
   * below the cap. Data holding writes is never dropped. Default: 256 MiB.
   */
  cacheBytes?: number
  /** Worker threads for the Node sync-fetch bridge. Default: 1. */
  workers?: number
  /** Log filesystem operations to the console. Default: false. */
  debug?: boolean
}

/**
 * Synchronous fetcher used by the filesystem's (synchronous, Emscripten
 * driven) read path. Implementations bridge to async I/O:
 * - Node: worker thread + SharedArrayBuffer + Atomics.wait
 * - Browser (inside a Web Worker): synchronous XMLHttpRequest
 */
export interface SyncFetcher {
  /**
   * Fetch a file, or an inclusive byte range of it, by data-directory
   * relative path ("/base/1/1259").
   */
  fetchSync(path: string, start?: number, end?: number): Uint8Array
  /** Release any resources (worker threads). */
  terminate(): void
}
