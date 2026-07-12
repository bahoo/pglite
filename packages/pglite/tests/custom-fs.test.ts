import { describe, it, expect } from 'vitest'
import { PGlite } from '../dist/index.js'
import { BaseFilesystem, type FsStats } from '../dist/fs/base.js'

/**
 * A minimal in-memory BaseFilesystem subclass that reports errors the way
 * Node's fs module (and most JS filesystem libraries) do: a plain Error with
 * a string `code` (e.g. 'ENOENT') and Node's own negative `errno` (e.g. -2).
 *
 * Custom filesystems following this convention previously broke on the
 * O_CREAT path: tryFSOperation passed the string code to FS.ErrnoError,
 * producing `errno: "ENOENT"`, which fails Emscripten's strict
 * `errno === 44` check in FS.lookupPath, so new files could never be
 * created and Postgres failed to boot.
 */

function throwNodeStyle(
  counters: { enoent: number },
  code: 'ENOENT' | 'EBADF' | 'EEXIST' | 'ENOTDIR' | 'ENOTEMPTY',
  nodeErrno: number,
  message: string,
): never {
  if (code === 'ENOENT') counters.enoent++
  const err = new Error(`${code}: ${message}`) as Error & {
    code: string
    errno: number
  }
  err.code = code
  err.errno = nodeErrno // Node's platform errno, deliberately NOT Emscripten's
  throw err
}

interface FileEntry {
  data: Uint8Array
  mode: number
}

class NodeStyleMemoryFS extends BaseFilesystem {
  counters = { enoent: 0 }
  #files = new Map<string, FileEntry>()
  #dirs = new Set<string>(['/'])
  #fds = new Map<number, string>()
  #nextFd = 1

  #norm(path: string): string {
    return path === '' ? '/' : path
  }

  #parent(path: string): string {
    return path.substring(0, path.lastIndexOf('/')) || '/'
  }

  #stats(size: number, mode: number): FsStats {
    const now = Date.now()
    return {
      dev: 0,
      ino: 0,
      mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      blksize: 4096,
      blocks: Math.ceil(size / 4096),
      atime: now,
      mtime: now,
      ctime: now,
    }
  }

  lstat(path: string): FsStats {
    const p = this.#norm(path)
    if (this.#dirs.has(p)) {
      return this.#stats(0, 0o40755)
    }
    const entry = this.#files.get(p)
    if (!entry) {
      throwNodeStyle(
        this.counters,
        'ENOENT',
        -2,
        `no such file or directory, lstat '${p}'`,
      )
    }
    return this.#stats(entry.data.length, 0o100000 | entry.mode)
  }

  fstat(fd: number): FsStats {
    const p = this.#fds.get(fd)
    if (!p) {
      throwNodeStyle(this.counters, 'EBADF', -9, `bad file descriptor, fstat`)
    }
    return this.lstat(p)
  }

  open(path: string): number {
    const fd = this.#nextFd++
    this.#fds.set(fd, this.#norm(path))
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
    const p = this.#fds.get(fd)
    if (!p) {
      throwNodeStyle(this.counters, 'EBADF', -9, `bad file descriptor, read`)
    }
    const entry = this.#files.get(p)
    if (!entry) return 0
    const available = Math.min(length, entry.data.length - position)
    if (available <= 0) return 0
    const target = new Uint8Array(buffer.buffer, offset, available)
    target.set(entry.data.subarray(position, position + available))
    return available
  }

  write(
    fd: number,
    buffer: Uint8Array | ArrayBuffer,
    offset: number,
    length: number,
    position: number,
  ): number {
    const p = this.#fds.get(fd)
    if (!p) {
      throwNodeStyle(this.counters, 'EBADF', -9, `bad file descriptor, write`)
    }
    const src = new Uint8Array(
      buffer instanceof ArrayBuffer ? buffer : buffer.buffer,
      offset,
      length,
    )
    let entry = this.#files.get(p)
    if (!entry) {
      entry = { data: new Uint8Array(0), mode: 0o600 }
      this.#files.set(p, entry)
    }
    const end = position + length
    if (end > entry.data.length) {
      const grown = new Uint8Array(end)
      grown.set(entry.data)
      entry.data = grown
    }
    entry.data.set(src, position)
    return length
  }

  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: string; mode?: number; flag?: string },
  ): void {
    const p = this.#norm(path)
    const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const existing = this.#files.get(p)
    this.#files.set(p, {
      data: new Uint8Array(buf),
      mode: options?.mode ?? existing?.mode ?? 0o600,
    })
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    const p = this.#norm(path)
    if (this.#dirs.has(p) || this.#files.has(p)) {
      throwNodeStyle(this.counters, 'EEXIST', -17, `file exists, mkdir '${p}'`)
    }
    const parent = this.#parent(p)
    if (!this.#dirs.has(parent)) {
      if (options?.recursive) {
        this.mkdir(parent, options)
      } else {
        throwNodeStyle(
          this.counters,
          'ENOENT',
          -2,
          `no such file or directory, mkdir '${p}'`,
        )
      }
    }
    this.#dirs.add(p)
  }

  readdir(path: string): string[] {
    const p = this.#norm(path)
    if (!this.#dirs.has(p)) {
      throwNodeStyle(
        this.counters,
        'ENOTDIR',
        -20,
        `not a directory, scandir '${p}'`,
      )
    }
    const names = new Set<string>()
    for (const dir of this.#dirs) {
      if (dir !== '/' && this.#parent(dir) === p) {
        names.add(dir.substring(dir.lastIndexOf('/') + 1))
      }
    }
    for (const file of this.#files.keys()) {
      if (this.#parent(file) === p) {
        names.add(file.substring(file.lastIndexOf('/') + 1))
      }
    }
    return [...names]
  }

  rename(oldPath: string, newPath: string): void {
    const from = this.#norm(oldPath)
    const to = this.#norm(newPath)
    const file = this.#files.get(from)
    if (file) {
      this.#files.set(to, file)
      this.#files.delete(from)
      return
    }
    if (this.#dirs.has(from)) {
      const prefix = `${from}/`
      for (const dir of [...this.#dirs]) {
        if (dir === from || dir.startsWith(prefix)) {
          this.#dirs.delete(dir)
          this.#dirs.add(`${to}${dir.substring(from.length)}`)
        }
      }
      for (const [path, entry] of [...this.#files]) {
        if (path.startsWith(prefix)) {
          this.#files.delete(path)
          this.#files.set(`${to}${path.substring(from.length)}`, entry)
        }
      }
      return
    }
    throwNodeStyle(
      this.counters,
      'ENOENT',
      -2,
      `no such file or directory, rename '${from}' -> '${to}'`,
    )
  }

  rmdir(path: string): void {
    const p = this.#norm(path)
    if (!this.#dirs.has(p)) {
      throwNodeStyle(
        this.counters,
        'ENOENT',
        -2,
        `no such file or directory, rmdir '${p}'`,
      )
    }
    if (this.readdir(p).length > 0) {
      throwNodeStyle(
        this.counters,
        'ENOTEMPTY',
        -39,
        `directory not empty, rmdir '${p}'`,
      )
    }
    this.#dirs.delete(p)
  }

  truncate(path: string, len = 0): void {
    const p = this.#norm(path)
    const entry = this.#files.get(p)
    if (!entry) {
      throwNodeStyle(
        this.counters,
        'ENOENT',
        -2,
        `no such file or directory, truncate '${p}'`,
      )
    }
    if (len <= entry.data.length) {
      entry.data = entry.data.slice(0, len)
    } else {
      const grown = new Uint8Array(len)
      grown.set(entry.data)
      entry.data = grown
    }
  }

  unlink(path: string): void {
    const p = this.#norm(path)
    if (!this.#files.delete(p)) {
      throwNodeStyle(
        this.counters,
        'ENOENT',
        -2,
        `no such file or directory, unlink '${p}'`,
      )
    }
  }

  chmod(path: string, mode: number): void {
    const entry = this.#files.get(this.#norm(path))
    if (entry) {
      entry.mode = mode
    }
  }

  utimes(): void {}
}

describe('custom BaseFilesystem', () => {
  it('boots and round-trips data with Node-style string error codes', async () => {
    const fs = new NodeStyleMemoryFS()
    const pg = await PGlite.create({ fs })

    await pg.exec(`
      CREATE TABLE test_custom_fs (id SERIAL PRIMARY KEY, value TEXT);
      INSERT INTO test_custom_fs (value) VALUES ('hello'), ('custom fs');
    `)
    const res = await pg.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM test_custom_fs;',
    )
    expect(res.rows[0].count).toBe(2)

    // Prove the string-code error path was actually exercised during boot:
    // initdb and Postgres startup must have looked up files that did not
    // exist yet, and our filesystem reports those as { code: 'ENOENT' }.
    expect(fs.counters.enoent).toBeGreaterThan(0)

    await pg.close()
  }, 120000)
})
