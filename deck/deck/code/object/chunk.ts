// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/chunk.ts's exports, with
// their shapes, answered by deck/deck/code/object/content-chunking.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-chunk.
import * as port from '@term/deck/code/object/content-chunking'


export type ChunkParams = { min: number; avg: number; max: number }

export const DEFAULT_CHUNK_PARAMS: ChunkParams = port.defaultChunkParams()

export const chunkBuffer = (input: { data: Buffer; params?: ChunkParams }): { start: number; end: number }[] =>
  port.chunkBuffer(input.data, input.params ?? DEFAULT_CHUNK_PARAMS)
