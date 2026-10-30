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
type CacheVerify = {
  hit: (key: string) => boolean
  twice: boolean
  ledger: boolean
}

const verifyModes = new Map<string, CacheVerify>()

export function cacheVerifyOf(text: string): CacheVerify {
  const known = verifyModes.get(text)

  if (known !== undefined) {return known}

  let rate = 0
  let twice = false
  let ledger = false

  for (const mode of text
    .split(',')
    .map(one => one.trim())
    .filter(Boolean)) {
    if (mode === 'twice') {twice = true}
    else if (mode === 'ledger') {ledger = true}
    else if (mode === 'hits') {rate = 1}
    else if (mode.startsWith('hits:')) {
      rate = Number(mode.slice(5))

      if (!(rate >= 0 && rate <= 1))
        {throw new Error(
          `TERM_CACHE_VERIFY: ${mode} wants a share from 0 to 1`,
        )}
    } else
      {throw new Error(
        `TERM_CACHE_VERIFY: ${mode} is not a verify mode (ledger, hits, hits:<rate>, twice)`,
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

  const verify = { hit: chosen, twice, ledger }
  verifyModes.set(text, verify)

  return verify
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
  },
): SeparateResult {
  const parsed = options.parsed ?? makeParseMemo()
  const { cache, explain } = options
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

    const r = compileProgram(
      program as never,
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

  const answer = port.compileSeparate(source, {
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
      cache!.unit<{ portable: string }>(key, () => ({
        portable: port.jobStored(job),
      })).portable,
    cachedNameKey: (key, job) =>
      cache!.unit<{ portable: string }>(key, () => ({
        portable: port.jobNamedKey(job),
      })).portable,
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
    built,
    reused,
    closureKey,
    natives,
    docks,
    rolls: answer.rolls.map(r => [r.label, r.roll as Roll]),
    ...kept,
  }
}
