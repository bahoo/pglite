import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { RemoteFilesystem, HttpFs, normalizeManifest } from '../dist/index.js'
import { writeManifest } from '../dist/manifest-node.js'

const DATA_DIR = join(tmpdir(), `pglite-httpfs-test-${process.pid}`)

let server: ChildProcess
let baseUrl: string

async function serverStats(): Promise<{
  requests: number
  rangeRequests: number
}> {
  const resp = await fetch(`${baseUrl}/__stats`)
  return resp.json()
}

/**
 * Bake a reference database onto local disk, generate its manifest, and
 * serve it over HTTP with Range support. The server runs as a child
 * process: the test thread blocks in Atomics.wait during remote fetches,
 * so an in-process server would deadlock.
 */
beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true })

  const pg = await PGlite.create(DATA_DIR)
  await pg.exec(`
    CREATE TABLE cities (id SERIAL PRIMARY KEY, name TEXT, pop INT);
    INSERT INTO cities (name, pop) VALUES
      ('Tokyo', 13960000),
      ('Delhi', 11030000),
      ('Shanghai', 24870000);
    CREATE TABLE filler AS
      SELECT g AS id, repeat('x', 512) AS pad FROM generate_series(1, 2000) g;
    CHECKPOINT;
  `)
  await pg.close()

  writeManifest(DATA_DIR)

  const serverScript = join(
    dirname(fileURLToPath(import.meta.url)),
    'serve-datadir.mjs',
  )
  server = spawn(process.execPath, [serverScript, DATA_DIR], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('test file server did not start')),
      10000,
    )
    server.stdout!.on('data', (chunk: Buffer) => {
      const match = chunk.toString().match(/LISTENING (\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(parseInt(match[1], 10))
      }
    })
    server.on('exit', (code) => reject(new Error(`server exited: ${code}`)))
  })
  baseUrl = `http://127.0.0.1:${port}`
}, 120000)

afterAll(() => {
  server?.kill()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

describe('RemoteFilesystem over HTTP', () => {
  it('boots and queries with default (auto) granularity', async () => {
    const pg = await PGlite.create({
      fs: new RemoteFilesystem({ backend: { type: 'http', baseUrl } }),
    })
    const res = await pg.query<{ name: string; pop: number }>(
      'SELECT name, pop FROM cities ORDER BY pop DESC;',
    )
    expect(res.rows.map((r) => r.name)).toEqual(['Shanghai', 'Tokyo', 'Delhi'])
    await pg.close()
  })

  it('boots and queries with page granularity (range reads)', async () => {
    const before = await serverStats()
    const pg = await PGlite.create({
      fs: new RemoteFilesystem({
        backend: { type: 'http', baseUrl },
        fetchGranularity: 'page',
        chunkPages: 4, // 32 KiB ranges — force plenty of range traffic
      }),
    })
    const res = await pg.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM filler;',
    )
    expect(res.rows[0].count).toBe(2000)

    const after = await serverStats()
    expect(after.rangeRequests).toBeGreaterThan(before.rangeRequests)
    await pg.close()
  })

  it('absorbs writes in the overlay (UPDATE on remote-backed table)', async () => {
    const pg = await PGlite.create({
      fs: new RemoteFilesystem({
        backend: { type: 'http', baseUrl },
        fetchGranularity: 'page',
      }),
    })
    await pg.query(`UPDATE cities SET pop = 40000000 WHERE name = 'Tokyo';`)
    const res = await pg.query<{ pop: number }>(
      `SELECT pop FROM cities WHERE name = 'Tokyo';`,
    )
    expect(res.rows[0].pop).toBe(40000000)
    await pg.close()
  })

  it('supports new tables created at runtime (local-only files)', async () => {
    const pg = await PGlite.create({
      fs: new RemoteFilesystem({ backend: { type: 'http', baseUrl } }),
    })
    await pg.exec(`
      CREATE TABLE scratch (id INT PRIMARY KEY, v TEXT);
      INSERT INTO scratch VALUES (1, 'overlay');
    `)
    const res = await pg.query<{ v: string }>('SELECT v FROM scratch;')
    expect(res.rows[0].v).toBe('overlay')
    await pg.close()
  })

  it('stays correct under a tiny cache budget (eviction + refetch)', async () => {
    const pg = await PGlite.create({
      fs: new RemoteFilesystem({
        backend: { type: 'http', baseUrl },
        fetchGranularity: 'page',
        chunkPages: 4,
        maxPagesPerFile: 8,
        cacheBytes: 512 * 1024,
      }),
    })
    const first = await pg.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM filler;',
    )
    const second = await pg.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM filler;',
    )
    expect(first.rows[0].count).toBe(2000)
    expect(second.rows[0].count).toBe(2000)
    await pg.close()
  })

  it('works through the HttpFs convenience wrapper', async () => {
    const pg = await PGlite.create({
      fs: new HttpFs(baseUrl, { fetchGranularity: 'file' }),
    })
    const res = await pg.query<{ n: number }>('SELECT 41 + 1 AS n;')
    expect(res.rows[0].n).toBe(42)
    await pg.close()
  })
})

describe('normalizeManifest', () => {
  it('accepts a flat entry array', () => {
    const entries = normalizeManifest([
      { path: 'PG_VERSION', size: 3 },
      { path: '/base', size: -1, type: 'dir' },
    ])
    expect(entries).toEqual([
      { path: '/PG_VERSION', size: 3 },
      { path: '/base', size: -1, type: 'dir' },
    ])
  })

  it('accepts a tar-index style { files } object with name fields', () => {
    const entries = normalizeManifest({
      files: [
        { name: '/global/pg_control', size: 8192 },
        { name: '/postmaster.pid', size: 40 },
      ],
    })
    expect(entries).toEqual([{ path: '/global/pg_control', size: 8192 }])
  })

  it('drops stale control files', () => {
    const entries = normalizeManifest([
      { path: '/postmaster.pid', size: 40 },
      { path: '/postmaster.opts', size: 20 },
      { path: '/index.json', size: 100 },
      { path: '/PG_VERSION', size: 3 },
    ])
    expect(entries).toEqual([{ path: '/PG_VERSION', size: 3 }])
  })
})
