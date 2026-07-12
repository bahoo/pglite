import type { ManifestInput, RemoteFileEntry } from './types.js'

/** Files that exist in a baked data directory but must not be served. */
const SKIP_FILES = new Set([
  '/postmaster.pid',
  '/postmaster.opts',
  '/index.json',
  '/manifest.json',
])

function normalizePath(p: string): string {
  return p.startsWith('/') ? p : `/${p}`
}

/**
 * Normalize any accepted manifest shape into a clean RemoteFileEntry list:
 * leading-slash paths, stale control files dropped.
 */
export function normalizeManifest(input: ManifestInput): RemoteFileEntry[] {
  const rawEntries = Array.isArray(input) ? input : input.files
  const entries: RemoteFileEntry[] = []
  for (const raw of rawEntries) {
    const path = normalizePath(
      (raw as { path?: string; name?: string }).path ??
        (raw as { path?: string; name?: string }).name ??
        '',
    )
    if (path === '/' || SKIP_FILES.has(path)) continue
    const isDir = raw.type === 'dir' || raw.size === -1
    entries.push(
      isDir ? { path, size: -1, type: 'dir' } : { path, size: raw.size },
    )
  }
  return entries
}

/**
 * Directories Postgres expects to exist even when empty. Empty directories
 * are not representable in S3 (and easily lost by tar/copy tooling), so the
 * filesystem always pre-creates them.
 */
export const REQUIRED_EMPTY_DIRS = [
  'pg_commit_ts',
  'pg_dynshmem',
  'pg_logical/mappings',
  'pg_logical/snapshots',
  'pg_multixact/members',
  'pg_multixact/offsets',
  'pg_notify',
  'pg_replslot',
  'pg_serial',
  'pg_snapshots',
  'pg_stat',
  'pg_stat_tmp',
  'pg_tblspc',
  'pg_twophase',
  'pg_wal',
]

/**
 * Files Postgres reads in full very early in startup. They are always
 * fetched whole (they are small), regardless of fetch granularity.
 */
export const BOOT_PRIORITY_FILES = new Set([
  '/PG_VERSION',
  '/postgresql.conf',
  '/postgresql.auto.conf',
  '/pg_hba.conf',
  '/pg_ident.conf',
  '/global/pg_control',
])
