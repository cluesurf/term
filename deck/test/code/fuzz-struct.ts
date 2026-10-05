/**
 * Structure-aware coverage-guided fuzzing: fuzz TYPED Seed values (records,
 * lists, nested) instead of raw integer tuples, mutating the structure
 * type-directed, the Hypothesis / Fuzzilli / libFuzzer-structured lever.
 *
 * Term since 2026-10-05 (deck/test/code/struct-fuzz.tree, paired against this
 * file's original over random shapes by tmp/pair-struct-fuzz.ts). This is its
 * face: a `SeedType` becomes the port's shape, the port's value becomes the
 * JavaScript value it describes, and a TypeScript target's closure sink and
 * throw become what the port takes.
 */

import { fuzzStruct as search } from '@term/test/code/struct-fuzz'
import { coverEdge, coverCompare } from '@term/test/code/coverage-fuzz'
import type { SeedType } from './type'
import type { Sink } from './fuzz'

/** An instrumented target over a typed value. */
export type StructTarget = (value: unknown, sink: Sink) => void

export type StructFuzzResult = {
  crash?: unknown
  execs: number
  edgesFound: number
  corpusSize: number
}

type Shape = { form: string; [key: string]: unknown }
type Sample = { form: string; value?: unknown; values?: Sample[]; names?: string[] }

/** A `SeedType` as the port's shape. */
export function shapeOf(type: SeedType): Shape {
  switch (type.form) {
    case 'list':
      return { form: 'list', item: shapeOf(type.item) }
    case 'record':
      return { form: 'record', names: type.fields.map(f => f.name), types: type.fields.map(f => shapeOf(f.type)) }
    case 'pick':
      return { form: 'pick', options: type.options.map(shapeOf) }
    default:
      return { form: type.form }
  }
}

/** The port's value as the JavaScript value it describes. */
export function plainOf(value: Sample): unknown {
  switch (value.form) {
    case 'items':
      return (value.values ?? []).map(plainOf)
    case 'fields':
      return Object.fromEntries((value.names ?? []).map((name, i) => [name, plainOf((value.values ?? [])[i]!)]))
    default:
      return value.value
  }
}

/** Coverage-guided fuzz over a typed input. */
export function fuzzStruct(input: {
  target: StructTarget
  type: SeedType
  iterations?: number
  seed?: number
}): StructFuzzResult {
  const failed = (value: Sample, sink: never): boolean => {
    try {
      input.target(plainOf(value), { edge: id => coverEdge(sink, id), cmp: (a, b) => coverCompare(sink, a, b) })

      return false
    } catch {
      return true
    }
  }
  const found = search(failed as never, shapeOf(input.type) as never, input.iterations ?? 50_000, input.seed ?? 1) as {
    crashed: boolean
    crash: Sample
    execs: number
    edgesFound: number
    corpusSize: number
  }

  return {
    ...(found.crashed ? { crash: plainOf(found.crash) } : {}),
    execs: found.execs,
    edgesFound: found.edgesFound,
    corpusSize: found.corpusSize,
  }
}
