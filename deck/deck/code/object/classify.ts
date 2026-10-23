// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/classify.ts's exports, with
// their shapes, answered by deck/deck/code/object/file-treatment.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-classify.
import * as port from '@term/deck/code/object/file-treatment'

export type ContentType = 'binary' | 'text' | 'tree'

export const extensionOf = (path: string): string => port.extensionOf(path)
export const looksTextual = (bytes: Buffer): boolean => port.looksTextual(bytes)
export const classify = (input: { path: string; bytes: Buffer }): ContentType => port.classify(input.path, input.bytes) as ContentType
