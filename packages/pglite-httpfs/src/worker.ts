/**
 * Worker-thread side of the Node sync-fetch bridge. Receives fetch
 * requests through a shared request buffer, performs the async backend
 * fetch, and writes the result into the shared response buffer.
 *
 * See node.ts for the signal protocol.
 */

import { isMainThread, workerData } from 'node:worker_threads'
import type { BackendConfig } from './types.js'
import type { Backend } from './backends/backend.js'

interface FetchRequest {
  path: string
  start?: number
  end?: number
}

if (!isMainThread && workerData?.pgliteHttpFsWorker) {
  const { sharedBuf, reqBuf, backend } = workerData as {
    sharedBuf: SharedArrayBuffer
    reqBuf: SharedArrayBuffer
    backend: BackendConfig
  }
  const signal = new Int32Array(sharedBuf, 0, 2)
  const data = new Uint8Array(sharedBuf, 8)
  const req = new Uint8Array(reqBuf)

  const backendPromise: Promise<Backend> =
    backend.type === 's3'
      ? import('./backends/s3.js').then((m) => m.createS3Backend(backend))
      : import('./backends/http.js').then((m) => m.createHttpBackend(backend))

  const readRequest = (): FetchRequest => {
    let end = 0
    while (req[end] !== 0 && end < req.length) end++
    return JSON.parse(new TextDecoder().decode(req.slice(0, end)))
  }

  const respond = (status: 2 | -1, payload: Uint8Array) => {
    data.set(payload)
    Atomics.store(signal, 1, payload.length)
    Atomics.store(signal, 0, status)
    Atomics.notify(signal, 0)
  }

  void (async () => {
    const impl = await backendPromise
    for (;;) {
      // Wait for a request (status 1); tolerate spurious wakeups and the
      // window where the main thread has not yet reset the previous
      // status back to 0.
      let status = Atomics.load(signal, 0)
      while (status !== 1) {
        Atomics.wait(signal, 0, status)
        status = Atomics.load(signal, 0)
      }
      let request: FetchRequest | undefined
      try {
        request = readRequest()
        const body = await impl.fetch(request.path, request.start, request.end)
        if (body.length > data.length) {
          throw new Error(
            `response of ${body.length} bytes exceeds the ${data.length}-byte shared buffer`,
          )
        }
        respond(2, body)
      } catch (err) {
        respond(
          -1,
          new TextEncoder().encode(
            err instanceof Error ? err.message : String(err),
          ),
        )
      }
    }
  })()
}
