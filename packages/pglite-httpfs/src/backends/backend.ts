import type { RemoteFileEntry } from '../types.js'

/**
 * Async backend interface. `list` runs on the main thread during (async)
 * filesystem init; `fetch` runs inside the sync-fetch bridge.
 */
export interface Backend {
  /** List every file in the remote data directory. */
  list(): Promise<RemoteFileEntry[]>
  /** Fetch a file, or an inclusive byte range of it. */
  fetch(path: string, start?: number, end?: number): Promise<Uint8Array>
}
