---
'@electric-sql/pglite': patch
---

Fix errno propagation for custom `BaseFilesystem` subclasses that throw errors with string codes (e.g. Node-style `{ code: 'ENOENT' }`). Previously the string was passed to `FS.ErrnoError` as if it were a numeric errno, which broke Emscripten's file-creation path and made PGlite fail to boot with "Bad file descriptor" errors. String codes are now mapped through `ERRNO_CODES`; numeric codes behave as before.
