import { ERRNO_CODES } from '@electric-sql/pglite/basefs'

/**
 * Error type understood by PGlite's BaseFilesystem bridge across all
 * released versions: `tryFSOperation` passes a numeric `code` straight to
 * Emscripten's `FS.ErrnoError`. (Errors with string codes such as
 * Node-style `{ code: 'ENOENT' }` are only handled correctly by PGlite
 * versions that map them through `ERRNO_CODES` — throwing the numeric
 * code directly works everywhere.)
 */
export class FsError extends Error {
  code: number
  constructor(code: keyof typeof ERRNO_CODES, message: string) {
    super(message)
    this.name = 'FsError'
    this.code = ERRNO_CODES[code]
  }
}
