// Text deltas: sending the changed lines instead of the changed file.
//
// Content-defined chunking deduplicates, it does not diff. Two versions of a file
// differing by one line share no chunks unless the chunker happened to cut around the
// edit, so a one-line change can re-upload the whole file.
//
// A delta fixes that for TEXT specifically, the way a git thin pack does: name a base
// the receiver already holds, send the hunks that differ, and let the receiver
// reconstruct. Binary gets nothing from this, since a line is not a meaningful unit
// there, and `.tree` gets nothing either, since it is records rather than lines.
//
// See note/library/base/design/content-types.md.

import { changeHunks, tokenize, detokenize } from '@term/base/code/text/diff'
import type { ChangeHunk } from '@term/base/code/text/diff'

import { hashObject } from './hash'

// A delta against a base the receiver holds. `base` is the object id of the text this
// was diffed against, so the receiver can find it and refuse if it does not have it.
export type TextDelta = {
  base: string
  // the id the reconstructed text must hash to, so a bad apply is caught rather than
  // written
  result: string
  hunks: Array<ChangeHunk>
}

// Below this, a delta is not worth the bookkeeping: the object is smaller than the
// message describing how to rebuild it.
const MINIMUM_TEXT_SIZE = 512

// A delta only pays if it is meaningfully smaller than the content it replaces.
// Otherwise send the content and skip a round of indirection.
const WORTHWHILE_RATIO = 0.6

/** Diff two texts into a delta, by line. */
export function makeTextDelta(input: {
  base: { id: string; text: string }
  next: { id: string; text: string }
}): TextDelta {
  return {
    base: input.base.id,
    result: input.next.id,
    hunks: changeHunks(
      tokenize(input.base.text, 'line'),
      tokenize(input.next.text, 'line'),
    ),
  }
}

/**
 * Rebuild the text a delta describes.
 *
 * Hunks are applied from the END backwards, so each hunk's `start` still refers to the
 * base's line numbering when it is used. Applying forwards would shift every later
 * hunk by the length change of every earlier one.
 */
export function applyTextDelta(input: {
  base: string
  delta: TextDelta
}): string {
  const lines = tokenize(input.base, 'line')
  const ordered = [...input.delta.hunks].sort(
    (a, b) => b.start - a.start,
  )

  for (const hunk of ordered) {
    lines.splice(hunk.start, hunk.length, ...hunk.content)
  }

  return detokenize(lines, 'line')
}

/**
 * Is a delta worth sending?
 *
 * Measured on the encoded size, not the hunk count: ten one-line hunks are cheaper than
 * one hunk replacing the file. A delta that saves little costs a base lookup, a
 * reconstruction and a verification for nothing.
 */
export function deltaIsWorthwhile(input: {
  delta: TextDelta
  nextSize: number
}): boolean {
  if (input.nextSize < MINIMUM_TEXT_SIZE) {
    return false
  }

  const encoded = Buffer.byteLength(
    JSON.stringify(input.delta.hunks),
    'utf8',
  )

  return encoded < input.nextSize * WORTHWHILE_RATIO
}

/**
 * Apply a delta and verify the result.
 *
 * The reconstructed text must hash to the id the delta claims. A delta built against a
 * different base, or corrupted in transit, produces different bytes and is rejected
 * here rather than written to disk.
 */
export function applyVerifiedTextDelta(input: {
  base: string
  delta: TextDelta
}): string {
  const text = applyTextDelta(input)
  const id = hashObject({
    kind: 'blob',
    bytes: Buffer.from(text, 'utf8'),
  })

  if (id !== input.delta.result) {
    throw new Error(
      `delta did not reconstruct its stated result: expected ${input.delta.result}, got ${id}`,
    )
  }

  return text
}
