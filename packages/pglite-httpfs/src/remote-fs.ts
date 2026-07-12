import { BaseFilesystem, type FsStats } from '@electric-sql/pglite/basefs'
import type { PGlite } from '@electric-sql/pglite'
import { FsError } from './fs-error.js'
import {
  BOOT_PRIORITY_FILES,
  REQUIRED_EMPTY_DIRS,
  normalizeManifest,
} from './manifest.js'
import { createSyncFetcher } from './sync-fetch/index.js'
import type {
  RemoteFileEntry,
  RemoteFilesystemOptions,
  SyncFetcher,
} from './types.js'

export const PAGE_SIZE = 8192 // Postgres page size

const DEFAULT_LAZY_THRESHOLD = 64 * 1024 * 1024 // 64 MiB
const DEFAULT_CHUNK_PAGES = 64 // 512 KiB per range request
const DEFAULT_MAX_PAGES_PER_FILE = 4096 // 32 MiB
const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024 // 256 MiB
const MIN_RESPONSE_BYTES = 1024 * 1024

interface FileEntry {
  /** Whole-file contents; null when not yet fetched (or lazy). */
  data: Uint8Array | null
  /** Current logical size of the file. */
  size: number
  /** Range-fetched instead of whole-fetched (large files). */
  lazy: boolean
  /**
   * How many leading bytes of the remote object are still valid backing
   * for this file. Starts at the manifest size; a truncate lowers it so
   * stale remote bytes past the truncation point are never served again.
   * -1 for files that exist only locally.
   */
  remoteSize: number
  /** Page cache for lazy files: page index → page bytes. */
  pages: Map<number, Uint8Array> | null
  /** Page indexes holding local writes; never evicted. */
  dirtyPages: Set<number> | null
  /** Whole-file entry holds local writes (never evicted / re-fetched). */
  dirty: boolean
  /** LRU clock value of the last access. */
  lastUsed: number
}

/**
 * A PGlite filesystem that lazily fetches database files from a remote
 * store (any HTTP file server or S3-compatible bucket) and keeps writes in
 * a copy-on-write memory overlay.
 *
 * - Small files are fetched whole on first access; files above
 *   `lazyThreshold` are range-fetched in chunks of Postgres pages, so a
 *   multi-GB data directory can be queried without downloading it.
 * - All writes (including the hint bits Postgres sets on heap pages while
 *   *reading*) are absorbed by the in-memory overlay. Writes are
 *   **ephemeral**: they last for the lifetime of the process and are never
 *   written back to the remote. Treat the remote data directory as a
 *   read-only snapshot.
 */
export class RemoteFilesystem extends BaseFilesystem {
  readonly #options: RemoteFilesystemOptions
  readonly #lazyThreshold: number
  readonly #chunkPages: number
  readonly #maxPagesPerFile: number
  readonly #cacheBytes: number

  #fetcher: SyncFetcher | null = null
  #files = new Map<string, FileEntry>()
  #dirs = new Map<string, Set<string>>() // dir path → child names
  #fds = new Map<number, string>()
  #nextFd = 10
  #cachedBytes = 0
  #clock = 0

  constructor(options: RemoteFilesystemOptions) {
    super(undefined, { debug: options.debug ?? false })
    this.#options = options
    this.#lazyThreshold =
      options.fetchGranularity === 'file'
        ? Number.POSITIVE_INFINITY
        : options.fetchGranularity === 'page'
          ? 0
          : (options.lazyThreshold ?? DEFAULT_LAZY_THRESHOLD)
    this.#chunkPages = options.chunkPages ?? DEFAULT_CHUNK_PAGES
    this.#maxPagesPerFile =
      options.maxPagesPerFile ?? DEFAULT_MAX_PAGES_PER_FILE
    this.#cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES
  }

  #log(...args: unknown[]) {
    if (this.debug) console.log('[pglite-httpfs]', ...args)
  }

  async init(
    pg: PGlite,
    emscriptenOptions: Parameters<BaseFilesystem['init']>[1],
  ): ReturnType<BaseFilesystem['init']> {
    const backendModule =
      this.#options.backend.type === 's3'
        ? await import('./backends/s3.js').then((m) =>
            m.createS3Backend(this.#options.backend as never),
          )
        : await import('./backends/http.js').then((m) =>
            m.createHttpBackend(this.#options.backend as never),
          )

    const entries = this.#options.manifest
      ? normalizeManifest(this.#options.manifest)
      : await backendModule.list()

    this.#registerEntries(entries)

    // The shared response buffer must hold the largest whole-file fetch
    // (chunked fetches are bounded by the chunk size).
    let largestWholeFile = 0
    for (const [path, entry] of this.#files) {
      if (!entry.lazy || BOOT_PRIORITY_FILES.has(path)) {
        largestWholeFile = Math.max(largestWholeFile, entry.size)
      }
    }
    this.#fetcher = await createSyncFetcher({
      backend: this.#options.backend,
      responseBytes: Math.max(
        MIN_RESPONSE_BYTES,
        this.#chunkPages * PAGE_SIZE,
        largestWholeFile,
      ),
      poolSize: this.#options.workers,
    })

    return super.init(pg, emscriptenOptions)
  }

  async closeFs(): Promise<void> {
    this.#fetcher?.terminate()
    this.#fetcher = null
    await super.closeFs()
  }

  // ---- manifest / registration -------------------------------------------

  #registerEntries(entries: RemoteFileEntry[]) {
    this.#mkdirAll('/')
    for (const dir of REQUIRED_EMPTY_DIRS) {
      this.#mkdirAll(`/${dir}`)
    }
    for (const entry of entries) {
      if (entry.type === 'dir') {
        this.#mkdirAll(entry.path)
        continue
      }
      const lazy =
        entry.size > this.#lazyThreshold && !BOOT_PRIORITY_FILES.has(entry.path)
      this.#files.set(entry.path, {
        data: null,
        size: entry.size,
        lazy,
        remoteSize: entry.size,
        pages: lazy ? new Map() : null,
        dirtyPages: lazy ? new Set() : null,
        dirty: false,
        lastUsed: 0,
      })
      this.#link(entry.path)
    }
  }

  #parentOf(path: string): string {
    return path.substring(0, path.lastIndexOf('/')) || '/'
  }

  #nameOf(path: string): string {
    return path.substring(path.lastIndexOf('/') + 1)
  }

  #mkdirAll(path: string) {
    if (this.#dirs.has(path)) return
    this.#dirs.set(path, new Set())
    if (path === '/' || path === '') return
    const parent = this.#parentOf(path)
    this.#mkdirAll(parent)
    this.#dirs.get(parent)!.add(this.#nameOf(path))
  }

  /** Register `path` as a child of its parent directory. */
  #link(path: string) {
    const parent = this.#parentOf(path)
    this.#mkdirAll(parent)
    this.#dirs.get(parent)!.add(this.#nameOf(path))
  }

  #unlink(path: string) {
    this.#dirs.get(this.#parentOf(path))?.delete(this.#nameOf(path))
  }

  #norm(path: string): string {
    return path === '' ? '/' : path
  }

  // ---- caching ------------------------------------------------------------

  #touch(entry: FileEntry) {
    entry.lastUsed = ++this.#clock
  }

  /** Fetch the whole file for a non-lazy entry, if not already present. */
  #materialize(path: string, entry: FileEntry): void {
    if (entry.data !== null || entry.lazy) return
    if (entry.remoteSize <= 0) {
      entry.data = new Uint8Array(entry.size)
      return
    }
    const body = this.#fetcher!.fetchSync(path)
    if (entry.size !== body.length) {
      // Trust the actual object over the manifest.
      entry.size = body.length
      entry.remoteSize = body.length
    }
    entry.data = body
    this.#cachedBytes += body.length
    this.#evictIfOver()
  }

  /**
   * Return the cached page for `pageIdx` of a lazy file, range-fetching a
   * chunk of neighbouring pages on a miss. Pages past the valid remote
   * range are served as writable zero pages.
   */
  #readPage(path: string, entry: FileEntry, pageIdx: number): Uint8Array {
    const pages = entry.pages!
    const hit = pages.get(pageIdx)
    if (hit) {
      // Refresh recency (Map preserves insertion order).
      pages.delete(pageIdx)
      pages.set(pageIdx, hit)
      return hit
    }

    const pageStart = pageIdx * PAGE_SIZE
    if (pageStart >= entry.remoteSize) {
      const zero = new Uint8Array(PAGE_SIZE)
      pages.set(pageIdx, zero)
      this.#cachedBytes += zero.length
      this.#trimPages(entry)
      return zero
    }

    const chunkSize = this.#chunkPages * PAGE_SIZE
    const chunkIdx = Math.floor(pageIdx / this.#chunkPages)
    const chunkStart = chunkIdx * chunkSize
    const chunkEnd = Math.min(chunkStart + chunkSize - 1, entry.remoteSize - 1)
    const body = this.#fetcher!.fetchSync(path, chunkStart, chunkEnd)
    this.#log('chunk fetch', path, `${chunkStart}-${chunkEnd}`)

    for (let i = 0; i < this.#chunkPages; i++) {
      const offset = i * PAGE_SIZE
      if (offset >= body.length) break
      const idx = chunkIdx * this.#chunkPages + i
      if (pages.has(idx)) continue // never clobber (possibly dirty) pages
      const slice = body.subarray(
        offset,
        Math.min(offset + PAGE_SIZE, body.length),
      )
      pages.set(idx, slice)
      this.#cachedBytes += slice.length
    }
    this.#trimPages(entry)
    this.#evictIfOver()
    return pages.get(pageIdx)!
  }

  /** Per-file page cap: evict the least recently used *clean* pages. */
  #trimPages(entry: FileEntry) {
    const pages = entry.pages!
    if (pages.size <= this.#maxPagesPerFile) return
    for (const [idx, page] of pages) {
      if (pages.size <= this.#maxPagesPerFile) break
      if (entry.dirtyPages!.has(idx)) continue
      pages.delete(idx)
      this.#cachedBytes -= page.length
    }
  }

  /** Global soft cap: drop clean cached data, least recently used first. */
  #evictIfOver() {
    if (this.#cachedBytes <= this.#cacheBytes) return
    const target = this.#cacheBytes * 0.8
    const candidates = [...this.#files.values()]
      .filter((e) => (e.data !== null && !e.dirty) || (e.pages?.size ?? 0) > 0)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    for (const entry of candidates) {
      if (this.#cachedBytes <= target) break
      if (entry.data !== null && !entry.dirty) {
        this.#cachedBytes -= entry.data.length
        entry.data = null
      } else if (entry.pages) {
        for (const [idx, page] of entry.pages) {
          if (entry.dirtyPages!.has(idx)) continue
          entry.pages.delete(idx)
          this.#cachedBytes -= page.length
          if (this.#cachedBytes <= target) break
        }
      }
    }
  }

  #dropCached(entry: FileEntry) {
    if (entry.data !== null) this.#cachedBytes -= entry.data.length
    if (entry.pages) {
      for (const page of entry.pages.values()) this.#cachedBytes -= page.length
    }
  }

  // ---- Filesystem API (called synchronously by the Emscripten bridge) -----

  lstat(path: string): FsStats {
    const p = this.#norm(path)
    this.#log('lstat', p)
    if (this.#dirs.has(p)) return stats(4096, true)
    const entry = this.#files.get(p)
    if (!entry) throw new FsError('ENOENT', `No such file or directory: ${p}`)
    return stats(entry.size, false)
  }

  fstat(fd: number): FsStats {
    const path = this.#fds.get(fd)
    if (!path) throw new FsError('EBADF', `Bad file descriptor: ${fd}`)
    return this.lstat(path)
  }

  open(path: string): number {
    const p = this.#norm(path)
    this.#log('open', p)
    if (!this.#files.has(p) && !this.#dirs.has(p)) {
      // Allow creation of files that do not exist remotely (postmaster.pid,
      // new WAL segments, ...). They live purely in the overlay.
      this.#files.set(p, {
        data: new Uint8Array(0),
        size: 0,
        lazy: false,
        remoteSize: -1,
        pages: null,
        dirtyPages: null,
        dirty: true,
        lastUsed: ++this.#clock,
      })
      this.#link(p)
    }
    const fd = this.#nextFd++
    this.#fds.set(fd, p)
    return fd
  }

  close(fd: number): void {
    this.#fds.delete(fd)
  }

  read(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const path = this.#fds.get(fd)
    if (!path) throw new FsError('EBADF', `Bad file descriptor: ${fd}`)
    const entry = this.#files.get(path)
    if (!entry) return 0
    this.#touch(entry)

    if (!entry.lazy) {
      this.#materialize(path, entry)
      const data = entry.data!
      const available = Math.min(length, data.length - position)
      if (available <= 0) return 0
      buffer.set(data.subarray(position, position + available), offset)
      return available
    }

    // Lazy path: assemble the read from cached / range-fetched pages.
    const end = Math.min(position + length, entry.size)
    if (position >= end) return 0
    let copied = 0
    let pos = position
    while (pos < end) {
      const pageIdx = Math.floor(pos / PAGE_SIZE)
      const pageBase = pageIdx * PAGE_SIZE
      const page = this.#readPage(path, entry, pageIdx)
      const from = pos - pageBase
      const to = Math.min(page.length, end - pageBase)
      if (to <= from) break
      buffer.set(page.subarray(from, to), offset + copied)
      copied += to - from
      pos = pageBase + to
    }
    return copied
  }

  write(
    fd: number,
    buffer: Uint8Array | ArrayBuffer,
    offset: number,
    length: number,
    position: number,
  ): number {
    const path = this.#fds.get(fd)
    if (!path) throw new FsError('EBADF', `Bad file descriptor: ${fd}`)
    const src = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
    let entry = this.#files.get(path)
    if (!entry) {
      entry = {
        data: new Uint8Array(0),
        size: 0,
        lazy: false,
        remoteSize: -1,
        pages: null,
        dirtyPages: null,
        dirty: true,
        lastUsed: 0,
      }
      this.#files.set(path, entry)
      this.#link(path)
    }
    this.#touch(entry)

    if (entry.lazy) {
      // Copy-on-write per page. Postgres sets hint bits on heap pages
      // during plain reads, so even "read-only" workloads write here.
      let written = 0
      let pos = position
      const end = position + length
      while (pos < end) {
        const pageIdx = Math.floor(pos / PAGE_SIZE)
        const pageBase = pageIdx * PAGE_SIZE
        let page = this.#readPage(path, entry, pageIdx)
        if (!entry.dirtyPages!.has(pageIdx) || page.length < PAGE_SIZE) {
          // Promote to a full-size writable copy owned by the overlay.
          const writable = new Uint8Array(PAGE_SIZE)
          writable.set(page)
          this.#cachedBytes += writable.length - page.length
          entry.pages!.set(pageIdx, writable)
          entry.dirtyPages!.add(pageIdx)
          page = writable
        }
        const from = pos - pageBase
        const to = Math.min(PAGE_SIZE, from + (end - pos))
        page.set(
          src.subarray(offset + written, offset + written + (to - from)),
          from,
        )
        written += to - from
        pos = pageBase + to
      }
      entry.size = Math.max(entry.size, end)
      return written
    }

    this.#materialize(path, entry)
    const need = position + length
    if (!entry.data || entry.data.length < need) {
      const grown = new Uint8Array(need)
      if (entry.data) grown.set(entry.data)
      this.#cachedBytes += grown.length - (entry.data?.length ?? 0)
      entry.data = grown
    }
    entry.data.set(src.subarray(offset, offset + length), position)
    entry.size = Math.max(entry.size, need)
    entry.dirty = true
    return length
  }

  writeFile(
    path: string,
    data: string | Uint8Array,
    _options?: { encoding?: string; mode?: number; flag?: string },
  ): void {
    const p = this.#norm(path)
    this.#log('writeFile', p)
    const bytes =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data)
    const existing = this.#files.get(p)
    if (existing) this.#dropCached(existing)
    this.#files.set(p, {
      data: bytes,
      size: bytes.length,
      lazy: false,
      remoteSize: -1,
      pages: null,
      dirtyPages: null,
      dirty: true,
      lastUsed: ++this.#clock,
    })
    this.#cachedBytes += bytes.length
    this.#link(p)
    this.#evictIfOver()
  }

  truncate(path: string, len = 0): void {
    const p = this.#norm(path)
    this.#log('truncate', p, len)
    const entry = this.#files.get(p)
    if (!entry) throw new FsError('ENOENT', `No such file or directory: ${p}`)
    this.#touch(entry)

    if (entry.lazy) {
      // No need to materialize: clamp the valid remote range and drop
      // cached pages past the new end. Reads past `size` return nothing;
      // pages between a later extension and `remoteSize` come back as
      // zero pages instead of stale remote bytes.
      entry.size = len
      entry.remoteSize = Math.min(entry.remoteSize, len)
      const lastPage = Math.ceil(len / PAGE_SIZE)
      for (const [idx, page] of entry.pages!) {
        if (idx < lastPage) continue
        entry.pages!.delete(idx)
        entry.dirtyPages!.delete(idx)
        this.#cachedBytes -= page.length
      }
      return
    }

    this.#materialize(p, entry)
    const data = entry.data!
    if (data.length === len) return
    const next = new Uint8Array(len)
    next.set(data.subarray(0, Math.min(data.length, len)))
    this.#cachedBytes += next.length - data.length
    entry.data = next
    entry.size = len
    entry.remoteSize = Math.min(entry.remoteSize, len)
    entry.dirty = true
  }

  unlink(path: string): void {
    const p = this.#norm(path)
    this.#log('unlink', p)
    const entry = this.#files.get(p)
    if (!entry) throw new FsError('ENOENT', `No such file or directory: ${p}`)
    this.#dropCached(entry)
    this.#files.delete(p)
    this.#unlink(p)
  }

  rename(oldPath: string, newPath: string): void {
    const from = this.#norm(oldPath)
    const to = this.#norm(newPath)
    this.#log('rename', from, to)

    const entry = this.#files.get(from)
    if (entry) {
      const target = this.#files.get(to)
      if (target) this.#dropCached(target)
      this.#files.delete(from)
      this.#files.set(to, entry)
      this.#unlink(from)
      this.#link(to)
      return
    }

    if (this.#dirs.has(from)) {
      const prefix = `${from}/`
      for (const dir of [...this.#dirs.keys()]) {
        if (dir !== from && !dir.startsWith(prefix)) continue
        const children = this.#dirs.get(dir)!
        this.#dirs.delete(dir)
        this.#dirs.set(`${to}${dir.substring(from.length)}`, children)
      }
      for (const [path, fileEntry] of [...this.#files]) {
        if (!path.startsWith(prefix)) continue
        this.#files.delete(path)
        this.#files.set(`${to}${path.substring(from.length)}`, fileEntry)
      }
      this.#unlink(from)
      this.#link(to)
      return
    }

    throw new FsError('ENOENT', `No such file or directory: ${from}`)
  }

  mkdir(path: string, _options?: { recursive?: boolean; mode?: number }): void {
    const p = this.#norm(path)
    this.#log('mkdir', p)
    this.#mkdirAll(p)
  }

  readdir(path: string): string[] {
    const p = this.#norm(path)
    this.#log('readdir', p)
    const children = this.#dirs.get(p)
    if (!children) {
      throw new FsError('ENOENT', `No such file or directory: ${p}`)
    }
    return [...children]
  }

  rmdir(path: string): void {
    const p = this.#norm(path)
    this.#log('rmdir', p)
    const children = this.#dirs.get(p)
    if (!children)
      throw new FsError('ENOENT', `No such file or directory: ${p}`)
    if (children.size > 0)
      throw new FsError('ENOTEMPTY', `Directory not empty: ${p}`)
    this.#dirs.delete(p)
    this.#unlink(p)
  }

  chmod(_path: string, _mode: number): void {}

  utimes(_path: string, _atime: number, _mtime: number): void {}
}

function stats(size: number, isDir: boolean): FsStats {
  const now = Date.now()
  return {
    dev: 0,
    ino: 0,
    mode: isDir ? 0o40755 : 0o100644,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    atime: now,
    mtime: now,
    ctime: now,
  }
}
