# @electric-sql/pglite-httpfs

A [PGlite](https://pglite.dev) filesystem that serves a Postgres data
directory straight from a remote store — any static HTTP host or any
S3-compatible bucket — fetching only the bytes Postgres actually reads.

- **Lazy range reads** — small files are fetched whole on first access;
  large files (heap tables, indexes) are fetched in chunks of 8 KB Postgres
  pages with HTTP `Range` / S3 ranged `GetObject` requests. A multi-GB
  database answers its first query after downloading a few MB.
- **Copy-on-write overlay** — Postgres writes even when you only read
  (hint bits on heap pages, `postmaster.pid`, WAL bookkeeping, `pg_stat`).
  All writes land in an in-memory overlay, page-granular for lazy files.
  The remote data directory is never modified.
- **Bounded memory** — global LRU byte budget plus a per-file page cap.
  Clean cached data is evicted and refetched on demand; pages holding
  writes are never dropped.
- **Runtimes** — Node (worker-thread + `SharedArrayBuffer` sync bridge,
  persistent worker pool) and browsers (synchronous `XMLHttpRequest`;
  HTTP backend only, and PGlite must run inside a Web Worker).

Writes are **ephemeral by design**: they last for the lifetime of the
process. Treat the remote data directory as a read-only snapshot — ideal
for serverless read replicas, data distribution, demo databases, and
analytics over published datasets.

## Usage

```ts
import { PGlite } from '@electric-sql/pglite'
import { RemoteFilesystem } from '@electric-sql/pglite-httpfs'

// Any static file host that supports Range requests
const pg = await PGlite.create({
  fs: new RemoteFilesystem({
    backend: { type: 'http', baseUrl: 'https://cdn.example.com/mydb' },
  }),
})

// Or an S3(-compatible) bucket — requires @aws-sdk/client-s3
const pgS3 = await PGlite.create({
  fs: new RemoteFilesystem({
    backend: {
      type: 's3',
      bucket: 'my-bucket',
      prefix: 'pglite/mydb/',
      clientConfig: { region: 'us-west-2' },
    },
  }),
})
```

Or the `HttpFs` shorthand:

```ts
import { HttpFs } from '@electric-sql/pglite-httpfs'

const pg = await PGlite.create({
  fs: new HttpFs('https://cdn.example.com/mydb', { fetchGranularity: 'page' }),
})
```

## Baking a data directory

1. Build the database with PGlite on local disk, then checkpoint and
   (optionally) trim recycled WAL so you don't ship empty segments:

   ```ts
   const pg = await PGlite.create('./mydb-data')
   // ... load data ...
   await pg.exec('CHECKPOINT;')
   await pg.close()
   ```

2. Generate the manifest the backends use as a file listing:

   ```ts
   import { writeManifest } from '@electric-sql/pglite-httpfs/manifest-node'
   writeManifest('./mydb-data') // writes ./mydb-data/index.json
   ```

3. Upload the directory to your host or bucket (for S3, also upload the
   manifest as `manifest.json` under the prefix, or let the backend fall
   back to a `ListObjectsV2` walk).

## Options

| Option             | Default | Meaning                                                                                             |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------- |
| `fetchGranularity` | `auto`  | `auto`: whole-fetch files up to `lazyThreshold`, range-fetch above. `file` / `page` force one mode. |
| `lazyThreshold`    | 64 MiB  | Size above which a file is range-fetched (in `auto` mode).                                          |
| `chunkPages`       | 64      | 8 KB pages fetched per range request (64 = 512 KiB).                                                |
| `maxPagesPerFile`  | 4096    | Per-file page-cache cap (clean pages evicted LRU-first).                                            |
| `cacheBytes`       | 256 MiB | Global soft cap on cached bytes.                                                                    |
| `workers`          | 1       | Node fetch-worker pool size.                                                                        |
| `manifest`         | —       | Pre-supplied file listing (skips the manifest fetch).                                               |
| `debug`            | `false` | Log filesystem operations.                                                                          |

## How it works

PGlite's filesystem callbacks are synchronous (Postgres runs on Emscripten's
FS layer), but network I/O is async. In Node, a persistent worker thread
performs the fetches while the calling thread blocks on `Atomics.wait` over
a `SharedArrayBuffer`. In browsers, PGlite already runs inside a Web
Worker, where the deprecated-but-supported synchronous `XMLHttpRequest`
does the same job with no extra worker.

The first write to a page of a lazily-fetched file promotes that page to a
writable copy owned by the overlay (this is what makes plain `SELECT`s work
at all — Postgres sets hint bits on heap pages as it scans them). Truncating
a lazy file clamps the valid remote range so stale remote bytes are never
served past the truncation point.
