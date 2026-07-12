/**
 * Node-only helper for generating a manifest (`index.json`) from a baked
 * PGlite data directory. Exported separately so browser bundles never touch
 * node:fs.
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteFileEntry } from './types.js'

/**
 * Walk a data directory and produce the file listing the HTTP backend
 * serves as `index.json` (and the S3 backend as `manifest.json`).
 */
export function generateManifest(dataDir: string): RemoteFileEntry[] {
  const entries: RemoteFileEntry[] = []
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = `${prefix}/${name}`
      const stat = statSync(full)
      if (stat.isDirectory()) {
        entries.push({ path: rel, size: -1, type: 'dir' })
        walk(full, rel)
      } else if (stat.isFile()) {
        entries.push({ path: rel, size: stat.size })
      }
    }
  }
  walk(dataDir, '')
  return entries
}

/** Generate the manifest and write it to `<dataDir>/index.json`. */
export function writeManifest(dataDir: string): RemoteFileEntry[] {
  const entries = generateManifest(dataDir)
  writeFileSync(join(dataDir, 'index.json'), JSON.stringify(entries))
  return entries
}
