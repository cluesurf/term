// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/tone.ts's exports, with
// their shapes, answered by deck/deck/code/object/tone-path.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-tone.
import * as port from '@term/deck/code/object/tone-path'

export const hexToTone = (hex: string): string => port.hexToTone(hex)
export const dashInEights = (flat: string): string =>
  port.dashInEights(flat)
export const toneOfId = (id: string): string => port.toneOfId(id)
export const objectKey = (input: {
  id: string
  extension: string
}): string => port.objectKey(input.id, input.extension)
export const tonePath = (id: string): string => port.tonePath(id)
