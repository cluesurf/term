// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/manifest.ts's exports, with
// their shapes, answered by deck/deck/code/object/file-manifest.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-manifest.
import * as port from '@term/deck/code/object/file-manifest'


export type ManifestEntry = { path: string; hash: string; size: number; mime?: string; pack?: string; site?: number }
export type HoldManifest = { package: string; ref: string; hash: string; files: ManifestEntry[] }
export type ManifestShard = { hash: string; foot: string; head: string; size: number; text: string }
export type ShardedManifest = { package: string; ref: string; hash: string; shards: ManifestShard[] }

export const manifestEntries = (input: { files: { path: string; blob: string; size: number }[]; placement: Map<string, unknown> }): ManifestEntry[] =>
  port.manifestEntries(input.files, input.placement)
export const emitManifest = (m: HoldManifest): string => port.emitManifest(m)
export const emitShardIndex = (m: ShardedManifest): string => port.emitShardIndex(m)
export const shardManifest = (input: { package: string; ref: string; hash: string; entries: ManifestEntry[]; minShardFiles?: number; avgShardFiles?: number }): ShardedManifest | HoldManifest =>
  port.shardManifest(input.package, input.ref, input.hash, input.entries, input.minShardFiles, input.avgShardFiles)
export const parseManifest = (text: string): HoldManifest | { package: string; ref: string; hash: string; shards: Omit<ManifestShard, 'text'>[] } =>
  port.parseManifest(text)
