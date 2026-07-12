/**
 * S3 backend — serves a PGlite data directory from an S3 bucket (or any
 * S3-compatible store) using ranged GetObject requests.
 *
 * `@aws-sdk/client-s3` is an optional peer dependency, imported lazily so
 * HTTP-only users never load it.
 */

import type { ManifestInput, S3BackendConfig } from '../types.js'
import { normalizeManifest } from '../manifest.js'
import type { Backend } from './backend.js'

export function createS3Backend(config: S3BackendConfig): Backend {
  const prefix = config.prefix.endsWith('/')
    ? config.prefix
    : `${config.prefix}/`

  let clientPromise: Promise<{
    client: InstanceType<typeof import('@aws-sdk/client-s3').S3Client>
    GetObjectCommand: typeof import('@aws-sdk/client-s3').GetObjectCommand
    ListObjectsV2Command: typeof import('@aws-sdk/client-s3').ListObjectsV2Command
  }> | null = null

  const getClient = () => {
    clientPromise ??= import('@aws-sdk/client-s3').then(
      ({ S3Client, GetObjectCommand, ListObjectsV2Command }) => ({
        client: new S3Client(config.clientConfig ?? {}),
        GetObjectCommand,
        ListObjectsV2Command,
      }),
    )
    return clientPromise
  }

  const getObject = async (key: string, range?: string) => {
    const s3 = await getClient()
    const resp = await s3.client.send(
      new s3.GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ...(range ? { Range: range } : {}),
      }),
    )
    return resp.Body!.transformToByteArray()
  }

  return {
    async list() {
      // Prefer a baked manifest.json; fall back to walking the prefix.
      try {
        const body = await getObject(`${prefix}manifest.json`)
        return normalizeManifest(
          JSON.parse(new TextDecoder().decode(body)) as ManifestInput,
        )
      } catch {
        // fall through to ListObjectsV2
      }
      const s3 = await getClient()
      const entries = []
      let continuationToken: string | undefined
      do {
        const resp = await s3.client.send(
          new s3.ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )
        for (const obj of resp.Contents ?? []) {
          if (!obj.Key || obj.Size === undefined) continue
          const path = `/${obj.Key.slice(prefix.length)}`
          if (path.endsWith('/')) {
            entries.push({ path: path.slice(0, -1), size: -1, type: 'dir' })
          } else {
            entries.push({ path, size: obj.Size })
          }
        }
        continuationToken = resp.NextContinuationToken
      } while (continuationToken)
      return normalizeManifest(entries as ManifestInput)
    },

    async fetch(path: string, start?: number, end?: number) {
      const key = prefix + path.replace(/^\//, '')
      const range =
        start !== undefined && end !== undefined
          ? `bytes=${start}-${end}`
          : undefined
      return getObject(key, range)
    },
  }
}
