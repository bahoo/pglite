/**
 * Static file server for tests, with Range support. Runs as a child
 * process: the thread using RemoteFilesystem blocks in Atomics.wait during
 * fetches, so the server must live outside it.
 *
 * Usage: node serve-datadir.mjs <dir>
 * Prints "LISTENING <port>" on stdout once ready.
 */
/* global process, console, URL */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: node serve-datadir.mjs <dir>')
  process.exit(1)
}

const stats = { requests: 0, rangeRequests: 0 }

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(stats))
    return
  }
  stats.requests++
  if (req.headers.range) stats.rangeRequests++
  const filePath = normalize(join(root, url.pathname))
  if (!filePath.startsWith(normalize(root))) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const size = statSync(filePath).size
  const match = req.headers.range?.match(/bytes=(\d+)-(\d+)?/)
  if (match) {
    const start = parseInt(match[1], 10)
    const end = Math.min(match[2] ? parseInt(match[2], 10) : size - 1, size - 1)
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
      'X-Requested-Range': req.headers.range ?? '',
    })
    createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Length': size })
    createReadStream(filePath).pipe(res)
  }
})

server.listen(0, '127.0.0.1', () => {
  console.log(`LISTENING ${server.address().port}`)
})
