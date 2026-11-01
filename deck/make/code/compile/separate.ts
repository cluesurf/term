// Separate compilation with early cutoff, what `term make` runs: compile/separate-units.tree (item term-self-host-001-0113)
// is the build. This face keeps the exported shapes and hands the port what Term cannot hold: the import walk, the mill
// cache, `compileProgram`, the options' lookups, the cache's two closures (each runs a port `unit-job` on a miss), and
// the stored entry's JSON, in the original's shape key for key. note/project/term/compiler/incremental-compilation.md

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Program, Statement } from '@term/make/code/compile/node'
import {
  collectModules,
  makeParseMemo,
} from '@term/make/code/compile/load'
import type {
  ParseMemo,
  Resolver,
  WalkMemo,
} from '@term/make/code/compile/load'
import {
  awaitsOutsideTasks,
  compileProgram,
  milledModule,
} from '@term/make/code/compile/compile'
import type { ModuleEmit } from '@term/make/code/compile/modules'
import type { Roll } from '@term/make/code/compile/roll'
import { units as unitsOf } from '@term/make/code/compile/unit-graph'
import type { UnitInputs } from '@term/make/code/compile/explain'
import {
  reviveBigint,
  storeBigint,
  cleanView,
  withoutWrites,
} from '@term/make/code/compile/cache'
import type { CompileCache } from '@term/make/code/compile/cache'
import type { Template } from '@term/make/code/compile/template'
import {
  checkerSwitchKey,
  unknownSeamOn,
} from '@term/make/code/check/strict'
import type { Tally } from '@term/make/code/check/holds'
import * as port from '@term/make/code/compile/separate-units'

// `term make --explain`: the inputs each unit was last built from, by its identity, and why each unit built this run was
export type UnitExplain = {
  recall: (id: string) => UnitInputs | undefined
  remember: (id: string, inputs: UnitInputs) => void
  reasons: Map<string, string[]>
}

type Export = {
  name: string
  exported: string
  file: string
  type: boolean
}
export type SeparateResult =
  | {
      ok: true
      modules: Map<string, ModuleEmit>
      warnings: Diagnostic[]
      openClaims?: string[]
      obligations?: Tally
      exports: Export[]
      built: string[]
      reused: string[]
      closureKey: string
      natives: Statement[]
      docks: Statement[]
      rolls: [string, Roll][]
      // with `keepProgram`: the entry unit's checked program when built this run, and the stubs of every unit reached
      program?: Program
      surface?: Program
    }
  | { ok: false; diagnostics: Diagnostic[] }

// the unit answers of one run, shared by a batch build's entries (each the port's `unit-answer`)
export type UnitMemo = Map<string, unknown>
export type Portable = {
  out: (text: string) => string
  in: (text: string) => string
}

const [none, some] = [
  { form: 'none' } as const,
  <T>(value: T) => ({ form: 'some', value }) as const,
]

const given = <T>(value: T | undefined | null) =>
  value ? some(value) : none

const tasksOf = (
  held: port.Portable,
): Portable & port.PortableTasks => {
  const [out, inward] = [
    (text: string) => port.portableWrite(held, text),
    (text: string) => port.portableRead(held, text),
  ]

  return { out, in: inward, outward: out, inward }
}

// `portableBy`'s two closures over the port's `portable` form
export const portableBy = (
  decks: { name: string; root: string }[],
): Portable => tasksOf(port.portableBy(decks as never))

// Tarjan strongly connected components, dependencies first: compile/unit-graph.tree
export const units = (
  files: string[],
  edges: Map<string, string[]>,
): string[][] => unitsOf(files, edges)

// THE UNITS A RULE REACHES (decision 093 of term/self-host/change/001-finish-self-host): the head of every unit that a
// unit stating a top-level `rule` reaches, through `edges`, as separate-units.tree `under-proof-of` reads a walk. A
// rule-stating importer asks such a unit under the key with bodies, so the pool's plan flags its own job to answer it
// that way too (`answerUnderProof`). `cut` is `units`' answer, a module's text the walk's (`walked`)
export function provedHeads(
  cut: string[][],
  edges: Map<string, string[]>,
  walked: WalkMemo,
  parsed: ParseMemo,
): Set<string> {
  const unitOf = new Map<string, number>()

  cut.forEach((unit, at) => {
    for (const file of unit) {unitOf.set(file, at)}
  })

  const states = (at: number): boolean =>
    cut[at]!.some(file => {
      const text = walked.get(file)?.text

      return (
        text !== undefined &&
        port.statesRule({ parsed } as never, { file, text } as never)
      )
    })

  const reached = new Set<number>()
  const reach = (at: number): void => {
    for (const file of cut[at]!) {
      for (const edge of edges.get(file) ?? []) {
        const dep = unitOf.get(edge)

        if (dep !== undefined && dep !== at && !reached.has(dep)) {
          reached.add(dep)
          reach(dep)
        }
      }
    }
  }

  cut.forEach((_, at) => {
    if (states(at)) {reach(at)}
  })

  return new Set([...reached].map(at => cut[at]![0]!))
}

// a unit's answer as the stored entry, key for key the original's, and back: what does not read back is a miss
const kept = (key: string, value: { form: string; value?: unknown }) =>
  value.form === 'some' ? { [key]: value.value } : {}

function stored(answer: port.UnitAnswer): unknown {
  if (answer.refused.form === 'some') {
    return { diagnostics: answer.refused.value }
  }

  const b = (answer.build as { value: port.UnitBuild }).value
  const head = {
    files: b.files.map(f => [f.file, f.emit]),
    stubs: b.stubs.map(s => [s.file, s.statements]),
    interfaceHash: b.interfaceHash,
  }

  return {
    ...head,
    ...kept('defs', b.defs),
    ...kept('docks', b.docks),
    ...kept('roll', b.roll),
    warnings: b.warnings,
    ...kept('openClaims', b.openClaims),
    ...kept('obligations', b.obligations),
  }
}

function restored(
  text: string,
): ReturnType<port.SeparateGiven['restore']> {
  try {
    const v = JSON.parse(text, reviveBigint) as Record<string, any>

    if (Array.isArray(v.diagnostics)) {
      return some({
        refused: some(v.diagnostics),
        build: none,
      }) as never
    }

    if (
      !Array.isArray(v.files) ||
      !Array.isArray(v.stubs) ||
      typeof v.interfaceHash !== 'string' ||
      typeof v.roll !== 'object'
    ) {
      return none
    }

    const [files, stubs] = [
      v.files.map(([file, emit]: [string, unknown]) => ({
        file,
        emit,
      })),
      v.stubs.map(([file, statements]: [string, unknown]) => ({
        file,
        statements,
      })),
    ]

    const [defs, docks] = [
      v.defs != null ? some(v.defs) : none,
      v.docks != null ? some(v.docks) : none,
    ]

    const build = {
      files,
      stubs,
      interfaceHash: v.interfaceHash,
      defs,
      docks,
      roll: given(v.roll),
      warnings: v.warnings,
      openClaims: given(v.openClaims),
      obligations: given(v.obligations),
    }

    return some({ refused: none, build: some(build) }) as never
  } catch {
    return none
  }
}

// TERM_CACHE_VERIFY (decision 077 section 5), a comma list, off by default: `hits` (or `hits:<rate>`, a share from 0 to
// 1) builds a unit the store answered again from nothing and compares the bytes, the share chosen by the unit's key so
// a rerun checks the same units; `twice` builds every unit built a second time and compares. A difference raises,
// naming the unit (separate-units.tree `verify-same`). Neither changes a key or an answer, so neither is in a key
// `ledger` records every read a unit's mill and check make, and fails a unit on one its key does not cover
// (build-ledger.tree)
// `trace` (decision 103 item 5) builds every unit built again in the same process with every carried shape and body its
// trace does not hold stripped, and fails on a difference, naming the unit, the stripped locator that moved it and the
// first differing byte
type CacheVerify = {
  hit: (key: string) => boolean
  twice: boolean
  ledger: boolean
  trace: boolean
}

const verifyModes = new Map<string, CacheVerify>()

export function cacheVerifyOf(text: string): CacheVerify {
  const known = verifyModes.get(text)

  if (known !== undefined) {return known}

  let rate = 0
  let twice = false
  let ledger = false
  let trace = false

  for (const mode of text
    .split(',')
    .map(one => one.trim())
    .filter(Boolean)) {
    if (mode === 'twice') {twice = true}
    else if (mode === 'ledger') {ledger = true}
    else if (mode === 'trace') {trace = true}
    else if (mode === 'hits') {rate = 1}
    else if (mode.startsWith('hits:')) {
      rate = Number(mode.slice(5))

      if (!(rate >= 0 && rate <= 1))
        {throw new Error(
          `TERM_CACHE_VERIFY: ${mode} wants a share from 0 to 1`,
        )}
    } else
      {throw new Error(
        `TERM_CACHE_VERIFY: ${mode} is not a verify mode (ledger, hits, hits:<rate>, twice, trace)`,
      )}
  }

  // FNV-1a of the key, as a share of 2^32: the same units are chosen on every run
  const chosen = (key: string): boolean => {
    if (rate >= 1) {return true}

    if (rate <= 0) {return false}

    let h = 0x811c9dc5

    for (let i = 0; i < key.length; i++)
      {h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0}

    return h / 4294967296 < rate
  }

  const verify = { hit: chosen, twice, ledger, trace }
  verifyModes.set(text, verify)

  return verify
}

// THE TRACE (decision 103 item 3): while a unit builds, every stub whose carried shape or body a prover table or the
// kernel consulted is told here by its locator, `<file>#<export>#<shape|body>` (the stub's file as its span names it,
// the name its own unit exports it by). Own definitions never enter it. A FRAME (check/hold-walk.tree) gathers what is
// told while it is open, so a hold memo entry keeps the trace of its walk, and a memo hit tells it again. The recorder
// is installed once per process, and tells nothing when no unit is open
// ONE RECORD A PROCESS, on globalThis: the recorder is one global too, and a process can load this module twice (a tsx
// program that imports it and also requires it), when the later copy's recorder would tell a set the unit never opened
type TraceState = {
  now: Set<string> | undefined
  frames: { id: number; seen: Set<string> }[]
  next: number
}
const traceHome = globalThis as { termCarriedState?: TraceState }
const traceState: TraceState = (traceHome.termCarriedState ??= {
  now: undefined,
  frames: [],
  next: 1,
})

function traceNote(locator: string): void {
  traceState.now?.add(locator)

  for (const frame of traceState.frames) {frame.seen.add(locator)}
}

type CarriedStub = {
  name?: string
  stub?: boolean
  stubExport?: string
  stubShape?: unknown
  stubBody?: unknown[]
  span?: { file?: string }
}

export function carriedLocator(statement: unknown, kind: 'shape' | 'body'): string {
  const s = statement as CarriedStub

  return `${s.span?.file ?? ''}#${s.stubExport ?? s.name ?? ''}#${kind}`
}

const traceGlobal = globalThis as {
  termCarriedTrace?: (statement: unknown, kind: string) => boolean
  termCarriedFrames?: {
    open: () => number
    close: (id: number) => string[]
    replay: (locators: string[]) => boolean
  }
  // a measurement's sink (task/term/trace-measure.ts): each unit built, its files, the carried shapes and bodies its
  // program holds, and those its trace holds
  termTraceSink?: (unit: {
    files: string[]
    carried: string[]
    traced: string[]
  }) => void
}

traceGlobal.termCarriedTrace = (statement, kind) => {
  traceNote(carriedLocator(statement, kind === 'body' ? 'body' : 'shape'))

  return true
}

traceGlobal.termCarriedFrames = {
  open: () => {
    const id = traceState.next++
    traceState.frames.push({ id, seen: new Set() })

    return id
  },
  // a frame and any opened after it and never closed (a raise inside the walk)
  close: id => {
    const at = traceState.frames.findIndex(frame => frame.id === id)

    if (at < 0) {return []}

    const seen = traceState.frames[at]!.seen
    traceState.frames.splice(at)

    return [...seen].sort()
  },
  replay: locators => {
    for (const locator of locators) {traceNote(locator)}

    return true
  },
}

// TERM_TRACE_SINK=<file>: every unit built appends one JSON line there ({files, carried, traced}), from whichever thread
// or process builds it, for task/term/trace-measure.ts. Read once, when this module loads, never inside a unit: it is
// no input of any answer
const TRACE_SINK = globalThis.process?.env?.TERM_TRACE_SINK

function sinkTrace(unit: { files: string[]; carried: string[]; traced: string[] }): void {
  traceGlobal.termTraceSink?.(unit)

  if (TRACE_SINK === undefined || TRACE_SINK === '') {return}

  const fs = (
    globalThis.process as
      | { getBuiltinModule?: (name: string) => unknown }
      | undefined
  )?.getBuiltinModule?.('node:fs') as
    | { appendFileSync: (file: string, text: string) => void }
    | undefined

  fs?.appendFileSync(TRACE_SINK, `${JSON.stringify(unit)}\n`)
}

// every carried shape and body a unit's program holds, by locator
function carriedOf(program: unknown[]): string[] {
  const out: string[] = []

  for (const one of program as (CarriedStub & { form?: string })[]) {
    if (one?.form !== 'function' || one.stub !== true) {continue}

    if (one.stubShape !== undefined) {out.push(carriedLocator(one, 'shape'))}

    if ((one.stubBody?.length ?? 0) > 0) {out.push(carriedLocator(one, 'body'))}
  }

  return out.sort()
}

// the program with every carried shape and body not in `keep` stripped: a shape set to none, a body emptied
function strippedOf(program: unknown[], keep: Set<string>): unknown[] {
  return (program as (CarriedStub & { form?: string })[]).map(one => {
    if (one?.form !== 'function' || one.stub !== true) {return one}

    const copy = { ...one }

    if (copy.stubShape !== undefined && !keep.has(carriedLocator(one, 'shape')))
      {delete copy.stubShape}

    if ((copy.stubBody?.length ?? 0) > 0 && !keep.has(carriedLocator(one, 'body')))
      {delete copy.stubBody}

    return copy
  })
}

// a unit answer's bytes, as the trace check compares them: what it emits and says, never the checked program, which
// holds the carried shapes and bodies themselves
function answerBytes(answer: unknown): string {
  const a = answer as Record<string, unknown>

  return JSON.stringify(
    [
      a.ok,
      a.diagnostics,
      a.modules instanceof Map ? [...a.modules] : a.modules,
      a.warnings,
      a.roll,
      a.openClaims,
      a.obligations,
    ],
    (_key, value: unknown) =>
      typeof value === 'bigint'
        ? `${value}n`
        : value instanceof Map
          ? [...value]
          : value instanceof Set
            ? [...value]
            : value,
  )
}

// THE LEDGER'S RECORDER (decision 077 section 5.1): under `ledger` the file system's synchronous readers and the
// environment are wrapped once in the process, and while a unit is open (`ledgerOpen` to `ledgerClose`) every read is
// recorded, whichever reader made it: the resolver, the role and deck lookups, the check's own reads of a module
// (staleFindsOf), or one nobody knew of. A read of the mill store is not (it is content-addressed by the mill's key), and
// a file read is marked with whether its bytes are the ones the walk read.
type LedgerRead = { reader: string; target: string; matches: boolean }
type LedgerOpen = { reads: LedgerRead[]; texts: Map<string, string> }

let ledgerOpenNow: LedgerOpen | undefined
let ledgerPaused = 0
let ledgerInstalled = false

function ledgerNote(
  reader: string,
  target: unknown,
  bytes?: unknown,
): void {
  const open = ledgerOpenNow

  if (
    open === undefined ||
    ledgerPaused > 0 ||
    typeof target !== 'string'
  )
    {return}

  // a descriptor opened is read with bytes nobody sees here, so it never matches
  const matches =
    reader === 'open'
      ? false
      : reader !== 'read'
        ? true
        : bytes === undefined
          ? false
          : open.texts.get(target) ===
            (typeof bytes === 'string' ? bytes : String(bytes))

  open.reads.push({ reader, target, matches })
}

function installLedger(): void {
  if (ledgerInstalled) {return}

  ledgerInstalled = true

  const host = globalThis.process as
    | (typeof globalThis.process & {
        getBuiltinModule?: (name: string) => unknown
      })
    | undefined

  const fs = host?.getBuiltinModule?.('node:fs') as
    | Record<string, unknown>
    | undefined

  const module = host?.getBuiltinModule?.('node:module') as
    | { syncBuiltinESMExports?: () => void }
    | undefined

  if (host === undefined || fs === undefined) {return}

  const readers: [string, string][] = [
    ['readFileSync', 'read'],
    ['existsSync', 'exists'],
    ['statSync', 'stat'],
    ['lstatSync', 'stat'],
    ['readdirSync', 'list'],
    ['openSync', 'open'],
  ]

  // only the outermost call is a read: one reader may call another through the module (under the gate a planted
  // readFileSync was first noted as an `open` of the same file), and that inner call is the same read
  let depth = 0

  for (const [name, reader] of readers) {
    const real = fs[name] as (...args: unknown[]) => unknown

    fs[name] = function (this: unknown, ...args: unknown[]): unknown {
      if (depth > 0) {return real.apply(this, args)}

      depth++

      let answer: unknown

      try {
        answer = real.apply(this, args)
      } finally {
        depth--
      }

      if (ledgerOpenNow !== undefined)
        {ledgerNote(
          reader,
          args[0],
          reader === 'read' ? answer : undefined,
        )}

      return answer
    }
  }

  module?.syncBuiltinESMExports?.()

  // reads pass through and are noted; a write goes to the environment itself (its own setter: `process.env` refuses
  // the define a proxy's default set would make)
  host.env = new Proxy(host.env, {
    get(target, key) {
      if (typeof key === 'string') {ledgerNote('env', key)}

      return Reflect.get(target, key)
    },
    set(target, key, value) {
      return Reflect.set(target, key, value)
    },
    has(target, key) {
      if (typeof key === 'string') {ledgerNote('env', key)}

      return Reflect.has(target, key)
    },
  })
}

// THE HELD ENTRIES of a store (decision 098 rule 6): each dirty unit's unit and name entry, the last per unit, which the
// store did not take while a file of the unit was unsaved. Kept beside the cache for the life of the process
type HeldEntry = { files: string[]; key: string; value: { portable: string } }
const heldEntries = new WeakMap<object, Map<string, HeldEntry>>()

function heldOf(cache: CompileCache): Map<string, HeldEntry> {
  const known = heldEntries.get(cache.state)

  if (known !== undefined) {return known}

  const made = new Map<string, HeldEntry>()
  heldEntries.set(cache.state, made)

  return made
}

// The held entries whose files are all clean again go to the store. Every request of a graph does this before it builds,
// a project request too: a save followed by a project request, with the unit memo capped past the dirty answer, would
// otherwise build the saved unit a second time (item term-self-host-001-0530)
export function flushHeld(
  cache: CompileCache | undefined,
  isClean: (file: string) => boolean,
): void {
  if (cache === undefined) {return}

  const held = heldOf(cache)

  for (const [place, entry] of held) {
    if (entry.files.every(isClean)) {
      held.delete(place)
      cache.unit(entry.key, () => entry.value)
    }
  }
}

export function compileSeparate(
  source: { file: string; text: string },
  options: {
    resolve: Resolver
    cache?: CompileCache
    modules: (file: string) => string
    env?: string
    roleOf?: (file: string) => string | null | undefined
    leanOf?: (file: string) => boolean | undefined
    deckOf?: (
      file: string,
    ) => { name: string; root: string } | undefined
    parsed?: ParseMemo
    units?: UnitMemo
    walked?: WalkMemo
    explain?: UnitExplain
    // hand back what the editor reads (`program`, `surface`): the language server
    keepProgram?: boolean
    // the pool's job for a cycle another unit imports: its import answer (`<head>#unit`) is built here too, by its one
    // owner (decision 088 of term/self-host/change/001-finish-self-host, separate-units.tree)
    answerAsImport?: boolean
    // the pool's job for a unit a rule-stating unit reaches: after the plain answer the walk is answered again with
    // every unit under proof, so the key with bodies that each rule-stating importer asks has one owner, this job
    // (decision 093). Its built units are added to `built`
    answerUnderProof?: boolean
    // THE STORE TAKES ONLY CLEAN FILES (decision 098 rule 6 of term/self-host/change/001-finish-self-host): a file is
    // clean when the disk holds the text compiled. A unit, its name key and its surface pointer are written only when
    // every own file is clean, a mill or scan entry only for a clean file; the rest stay in memory. Absent: every write
    isClean?: (file: string) => boolean
  },
): SeparateResult {
  const parsed = options.parsed ?? makeParseMemo()
  const { explain, isClean } = options
  const cache =
    options.cache !== undefined && isClean !== undefined
      ? cleanView(options.cache, isClean)
      : options.cache
  // a unit's own entries go to the store only when each of its files is clean; a dirty unit's entry is held, the last
  // one per unit and slot, and written by the first document request that finds all its files clean again (the save),
  // so the store takes the answer the graph's unit memo already holds without building the unit twice
  const held = options.cache !== undefined ? heldOf(options.cache) : undefined
  const unitWrite = (
    job: unknown,
    slot: string,
    key: string,
    run: () => { portable: string },
  ): string => {
    const files = (job as { state: { files: string[] } }).state.files
    const place = `${slot}\u0000${files.join('\u0000')}`

    if (isClean === undefined || files.every(isClean)) {
      held?.delete(place)

      return run().portable
    }

    // a dirty unit asked again under the same key is the answer already built: a capped memo may have let it go while
    // the store never took it, and another document reaching it must not build it again (item term-self-host-001-0530)
    const kept = held?.get(place)

    if (kept?.key === key) {return kept.value.portable}

    const value = withoutWrites(options.cache!, run)
    held?.set(place, { files, key, value })

    return value.portable
  }

  if (isClean !== undefined) {flushHeld(options.cache, isClean)}

  const verify = cacheVerifyOf(
    globalThis.process?.env?.TERM_CACHE_VERIFY ?? '',
  )

  // the walk's text of every module, which a file read under `ledger` must have read
  const ledgerTexts = new Map<string, string>()

  if (verify.ledger) {installLedger()}

  const [role, lean] = [
    (file: string) => options.roleOf?.(file) ?? undefined,
    (file: string) => options.leanOf?.(file) ?? false,
  ]

  const compileUnit: port.SeparateGiven['compileUnit'] = (
    program,
    checkedAs,
    scope,
    naming,
    files,
  ) => {
    // a test plants a read here, to see the ledger name it (test/compile/cache-verify.ts)
    if (verify.ledger)
      {(
        globalThis as { termLedgerPlant?: (files: string[]) => void }
      ).termLedgerPlant?.(files)}

    // the program as handed in, before a compile writes into it: the trace check builds it again stripped
    const pristine =
      verify.trace ? structuredClone(program as unknown[]) : undefined
    const run = (given: unknown) =>
      compileProgram(
        given as never,
        checkedAs,
        undefined,
        true,
        options.modules,
        undefined,
        options.env,
        false,
        false,
        options.deckOf,
        scope as never,
        undefined,
        undefined,
        naming,
        new Set(files),
      )
    const carried = carriedOf(program as unknown[])
    const outer = traceState.now
    traceState.now = new Set()

    let r: ReturnType<typeof run>
    let traced: Set<string>

    try {
      r = run(program)
    } finally {
      traced = traceState.now
      traceState.now = outer
    }

    sinkTrace({ files, carried, traced: [...traced].sort() })

    // THE TRACE CHECK (decision 103 item 5): what the trace does not hold, the answer must not read
    if (pristine !== undefined) {
      const untraced = carried.filter(locator => !traced.has(locator))

      if (untraced.length > 0) {
        const answer = answerBytes(r)
        const quiet = (given: unknown[]) => {
          const held = traceState.now
          traceState.now = undefined

          try {
            return answerBytes(run(structuredClone(given)))
          } finally {
            traceState.now = held
          }
        }
        const stripped = quiet(strippedOf(pristine, traced))

        if (stripped !== answer) {
          // the one stripped locator that moves the answer alone, and where the bytes part
          const moved =
            untraced.find(
              locator =>
                quiet(
                  strippedOf(
                    pristine,
                    new Set(carried.filter(one => one !== locator)),
                  ),
                ) !== answer,
            ) ?? untraced.join(', ')
          let at = 0

          while (at < answer.length && answer[at] === stripped[at]) {at++}

          throw new Error(
            `TERM_CACHE_VERIFY trace: unit ${files.join(', ')} answers otherwise with its untraced carried shapes ` +
              `and bodies stripped. Moved by ${moved}. First differing byte at ${at}: ` +
              `${JSON.stringify(answer.slice(at, at + 80))} vs ${JSON.stringify(stripped.slice(at, at + 80))}`,
          )
        }
      }
    }

    if (!r.ok) {
      return {
        ok: false,
        diagnostics: r.diagnostics,
        program: [],
        modules: [],
        warnings: [],
        roll: none,
        openClaims: [],
        obligations: none,
      } as never
    }

    const modules = [...(r.modules ?? [])].map(([file, emit]) => ({
      file,
      emit,
    }))

    return {
      ok: true,
      diagnostics: [],
      program: r.program,
      modules,
      warnings: r.warnings,
      roll: given(r.roll),
      openClaims: r.openClaims ?? [],
      obligations: given(r.obligations),
    } as never
  }

  const answerOf = (underProofAll: boolean) => port.compileSeparate(source, {
    collect: () => {
      const collected = collectModules(
        source,
        options.resolve,
        parsed,
        cache
          ? (unit, compute) =>
              cache.scanned(unit.file, unit.text, compute)
          : undefined,
        options.walked,
      )

      if (verify.ledger) {
        for (const unit of collected.sources)
          {ledgerTexts.set(unit.file, unit.text)}
      }

      return collected
    },
    deckOf: file => given(options.deckOf?.(file)),
    roleOf: file => role(file) ?? '',
    leanOf: lean,
    moduleOf: file => options.modules(file),
    parsed,
    milled: (unit, templates, templateKey) => {
      const [unitRole, unitLean] = [role(unit.file), lean(unit.file)]

      // the mill store's reads are keyed by what the mill reads (content-addressed), so the ledger skips them
      ledgerPaused++

      try {
        return milledModule(unit, {
          parsed,
          templates: templates as Map<string, Template>,
          templateKey,
          cache,
          role: unitRole,
          lean: unitLean,
        })
      } finally {
        ledgerPaused--
      }
    },
    compileUnit,
    hasStubExport: s =>
      (s as { stubExport?: string }).stubExport !== undefined,
    portableTasks: tasksOf,
    switchKey: () =>
      checkerSwitchKey(awaitsOutsideTasks(), unknownSeamOn()),
    env: options.env ?? '',
    hasCache: cache !== undefined,
    unitVersion: () => cache?.versionOf('unit') ?? '',
    cachedUnit: (key, job) =>
      unitWrite(job, 'unit', key, () =>
        cache!.unit<{ portable: string }>(key, () => ({
          portable: port.jobStored(job),
        })),
      ),
    cachedNameKey: (key, job) =>
      unitWrite(job, 'name', key, () =>
        cache!.unit<{ portable: string }>(key, () => ({
          portable: port.jobNamedKey(job),
        })),
      ),
    store: unit => JSON.stringify(stored(unit), storeBigint),
    restore: restored,
    hasUnits: options.units !== undefined,
    units: (options.units ?? new Map()) as never,
    hasExplain: explain !== undefined,
    recall: id => given(explain?.recall(id)) as never,
    remember: (id, inputs) => (
      explain?.remember(id, inputs as never),
      true
    ),
    giveReasons: (label, reasons) => (
      explain?.reasons.set(label, reasons),
      true
    ),
    keepProgram: options.keepProgram === true,
    answerAsImport: options.answerAsImport === true,
    underProofAll,
    verifyHit: verify.hit,
    verifyTwice: verify.twice,
    ledger: verify.ledger,
    ledgerOpen: () => {
      ledgerOpenNow = { reads: [], texts: ledgerTexts }

      return true
    },
    ledgerClose: () => {
      const reads = ledgerOpenNow?.reads ?? []
      ledgerOpenNow = undefined

      return reads as never
    },
    separator: globalThis.process?.platform === 'win32' ? '\\' : '/',
  } as never)

  const answer = answerOf(false)
  // the units this walk built under proof, for a job that owns its unit's key with bodies (decision 093)
  let provedBuilt: string[] = []

  if (answer.refused.form === 'none' && options.answerUnderProof === true) {
    const proved = answerOf(true)

    if (proved.refused.form === 'none') {
      provedBuilt = (proved as never as { built: string[] }).built
    }
  }

  if (answer.refused.form === 'some') {
    return {
      ok: false,
      diagnostics: answer.refused.value as Diagnostic[],
    }
  }

  const kept = options.keepProgram
    ? {
        surface: answer.surface as Program,
        ...(answer.program.form === 'some'
          ? { program: answer.program.value as Program }
          : {}),
      }
    : {}

  const claims =
    answer.openClaims.form === 'some'
      ? { openClaims: answer.openClaims.value }
      : {}

  const owed =
    answer.obligations.form === 'some'
      ? { obligations: answer.obligations.value as Tally }
      : {}

  const {
    modules,
    warnings,
    exports,
    built,
    reused,
    closureKey,
    natives,
    docks,
  } = answer as never as Extract<SeparateResult, { ok: true }>

  return {
    ok: true,
    modules,
    warnings,
    ...claims,
    ...owed,
    exports,
    built: provedBuilt.length > 0 ? [...built, ...provedBuilt] : built,
    reused,
    closureKey,
    natives,
    docks,
    rolls: answer.rolls.map(r => [r.label, r.roll as Roll]),
    ...kept,
  }
}
