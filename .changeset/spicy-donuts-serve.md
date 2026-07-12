---
'@electric-sql/pglite-httpfs': patch
---

New package: a remote-backed filesystem for PGlite that serves a data directory from any HTTP host or S3-compatible bucket. Lazy range reads (8 KB page granularity with chunked fetches), a copy-on-write in-memory overlay for writes (including hint-bit writes during plain reads), LRU cache budgets, and a Node worker-thread/`SharedArrayBuffer` sync bridge with a browser sync-XHR fallback.
