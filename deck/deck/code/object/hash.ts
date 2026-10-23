// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/hash.ts's exports, with
// their shapes, answered by deck/deck/code/object/object-address.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-hash.
import * as port from '@term/deck/code/object/object-address'

export type ObjectKind = 'chunk' | 'blob' | 'tree' | 'commit' | 'pack'

export const hashObject = (input: { kind: ObjectKind; bytes: Buffer }): string => port.hashObject(input.kind, input.bytes)
export const hashObjectText = (input: { kind: ObjectKind; text: string }): string => port.hashObjectText(input.kind, input.text)
export const isObjectId = (value: string): boolean => port.isObjectId(value)
export const idShard = (id: string): string => port.idShard(id)
export const idHex = (id: string): string => port.idHex(id)
