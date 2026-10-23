// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/delta.ts's exports, with
// their shapes, answered by deck/deck/code/object/text-delta.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-delta.
import * as port from '@term/deck/code/object/text-delta'

export type TextDelta = { base: string; result: string; hunks: unknown[] }

export const makeTextDelta = (input: { base: { id: string; text: string }; next: { id: string; text: string } }): TextDelta =>
  port.makeTextDelta(input.base, input.next) as TextDelta
export const applyTextDelta = (input: { base: string; delta: TextDelta }): string => port.applyTextDelta(input.base, input.delta)
export const deltaIsWorthwhile = (input: { delta: TextDelta; nextSize: number }): boolean => port.deltaIsWorthwhile(input.delta, input.nextSize)
export const applyVerifiedTextDelta = (input: { base: string; delta: TextDelta }): string => port.applyVerifiedTextDelta(input.base, input.delta)
