// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/pack.ts's exports, with
// their shapes, answered by deck/deck/code/object/blob-packing.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-pack.
import * as port from '@term/deck/code/object/blob-packing'

export type Placement = { kind: 'loose' } | { kind: 'pack'; pack: string; site: number; size: number }
export type Pack = { id: string; bytes: Buffer; blobs: string[] }
export type PackInput = { id: string; path: string; bytes: Buffer }
export type PackParams = { looseThreshold: number; minPack: number; maxPack: number; boundaryAvg: number }
export type OpenPack = { body: Buffer; toc: { id: string; site: number; size: number }[] }

export const DEFAULT_PACK_PARAMS: PackParams = port.defaultPackParams()

export const isPackable = (input: { path: string; size: number; bytes: Buffer; params?: PackParams }): boolean =>
  port.isPackable(input.path, input.size, input.bytes, input.params ?? DEFAULT_PACK_PARAMS)
export const reconstructBlob = (input: { blobId: string; store: unknown }): Promise<Buffer> => port.reconstructBlob(input.blobId, input.store) as Promise<Buffer>
export const buildPacks = (input: { blobs: PackInput[]; params?: PackParams }): { packs: Pack[]; placement: Map<string, Placement> } =>
  port.buildPacks(input.blobs, input.params ?? DEFAULT_PACK_PARAMS) as never
export const openPack = (bytes: Buffer): OpenPack => port.openPack(bytes) as OpenPack
export const slicePack = (open: OpenPack, site: number, size: number): Buffer => port.slicePack(open, site, size) as Buffer
