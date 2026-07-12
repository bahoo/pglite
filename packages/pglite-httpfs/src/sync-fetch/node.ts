/**
 * Node sync-fetch bridge: a pool of persistent worker threads performs the
 * async I/O while the calling thread blocks on Atomics.wait. PGlite's
 * filesystem callbacks are synchronous (they are driven by Emscripten FS),
 * so blocking here is what makes remote fetches possible at all.
 *
 * Shared-buffer protocol, per worker slot:
 *   signal[0]: 0 idle → 1 request ready → 2 ok / -1 error → 0 idle ...
 *   signal[1]: response byte length
 *   data region: response bytes (or UTF-8 error message on failure)
 */

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { BackendConfig, SyncFetcher } from '../types.js'

const REQ_BUF_SIZE = 8192
const HEADER_BYTES = 8
const DEFAULT_TIMEOUT_MS = 60_000

interface WorkerSlot {
  worker: Worker
  signal: Int32Array
  data: Uint8Array
  req: Uint8Array
  /** Set when the worker errored or exited; fetchSync fails fast. */
  dead: string | null
}

export interface NodeFetcherOptions {
  backend: BackendConfig
  /** Size of each worker's shared response buffer, in bytes. */
  responseBytes: number
  poolSize?: number
  /** Per-request timeout for the blocking wait. Default: 60s. */
  timeoutMs?: number
}

function createSlot(backend: BackendConfig, responseBytes: number): WorkerSlot {
  const shared = new SharedArrayBuffer(HEADER_BYTES + responseBytes)
  const reqBuf = new SharedArrayBuffer(REQ_BUF_SIZE)
  const workerUrl = new URL('./worker.js', import.meta.url)
  const worker = new Worker(fileURLToPath(workerUrl), {
    workerData: {
      pgliteHttpFsWorker: true,
      sharedBuf: shared,
      reqBuf,
      backend,
    },
  })
  worker.unref()
  const slot: WorkerSlot = {
    worker,
    signal: new Int32Array(shared, 0, 2),
    data: new Uint8Array(shared, HEADER_BYTES),
    req: new Uint8Array(reqBuf),
    dead: null,
  }
  // A dead worker must never leave the main thread blocked: record the
  // reason and wake any waiter (it re-checks state after every wake).
  worker.on('error', (err) => {
    slot.dead = String(err?.stack ?? err)
    Atomics.notify(slot.signal, 0)
  })
  worker.on('exit', (code) => {
    slot.dead ??= `worker exited with code ${code}`
    Atomics.notify(slot.signal, 0)
  })
  return slot
}

export function createNodeFetcher(options: NodeFetcherOptions): SyncFetcher {
  const poolSize = Math.max(1, options.poolSize ?? 1)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const slots: WorkerSlot[] = []
  for (let i = 0; i < poolSize; i++) {
    slots.push(createSlot(options.backend, options.responseBytes))
  }
  let next = 0

  return {
    fetchSync(path: string, start?: number, end?: number): Uint8Array {
      const slot = slots[next++ % slots.length]
      if (slot.dead) {
        throw new Error(`pglite-httpfs: fetch worker died: ${slot.dead}`)
      }
      const payload = new TextEncoder().encode(
        JSON.stringify({ path, start, end }),
      )
      if (payload.length >= slot.req.length) {
        throw new Error(`pglite-httpfs: request too large for path ${path}`)
      }
      slot.req.set(payload)
      slot.req[payload.length] = 0

      Atomics.store(slot.signal, 0, 1)
      Atomics.notify(slot.signal, 0)
      // Wait for the worker to replace 1 with a status code. The loop
      // guards against spurious wakeups; the deadline guards against a
      // wedged worker.
      const deadline = Date.now() + timeoutMs
      let status = 1
      while ((status = Atomics.load(slot.signal, 0)) === 1) {
        if (slot.dead) {
          throw new Error(`pglite-httpfs: fetch worker died: ${slot.dead}`)
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error(
            `pglite-httpfs: fetch timed out after ${timeoutMs}ms: ${path}`,
          )
        }
        Atomics.wait(slot.signal, 0, 1, Math.min(remaining, 1000))
      }
      const length = Atomics.load(slot.signal, 1)
      const ok = status === 2
      const out = new Uint8Array(length)
      out.set(slot.data.subarray(0, length))
      Atomics.store(slot.signal, 0, 0)
      Atomics.notify(slot.signal, 0)
      if (!ok) {
        throw new Error(
          `pglite-httpfs: fetch failed for ${path}: ${new TextDecoder().decode(out)}`,
        )
      }
      return out
    },

    terminate() {
      for (const slot of slots) {
        slot.dead ??= 'fetcher terminated'
        void slot.worker.terminate()
      }
      slots.length = 0
    },
  }
}
