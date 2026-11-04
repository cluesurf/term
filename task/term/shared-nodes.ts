// The sharing census (item term-self-host-001-0037, D011): how many objects of a program stand at two or more places,
// per pipeline stage, measured and never predicted.
//
//   sh tmp/run-term.sh npx tsx task/term/shared-nodes.ts [--stage checked|lowered|stamped|all]
//     [--sample N] [--seed S] [--expect-zero <stage>] [--modules <stage>] [--where <stage>]
//
// --where <stage> attributes each shared object of that stage to the key paths that hold it (the last three keys of every
// path reaching it, indices dropped), grouped by form and path set, largest first, 15 lines at most.
//
// A PLACE is an expression or a statement of the program, met once per standing in the pre-order of
// deck/make/code/compile/place-walk.tree (fields as node.tree declares them, a node's `type` and `span` never entered; a
// type is entered only where place-walk.tree enters one, for the value arguments of a named type). The walk below is
// that file written in TypeScript, in its declared order, and never a walk of `Object.keys`. An object standing at two
// places is SHARED. The stages:
//
//   checked  `compile(..., { optimize: false }).program`   the parser and the checker share nothing (finding/node-identity.md)
//   lowered  `compile(...).program`                          the simplifier substitutes one object at every use
//   stamped  `stampPlaces(lowered)` from compile/place-stamp, when that module exists, else skipped with the reason
//
// The corpus is the input builder of tmp/pair-intervals.ts (traps.md T025): every checked file of the
// decks and the tests, the mark benchmarks, and random files, each compiled whole as a library. That file runs on import
// and exports nothing, so its file picks are written out here (the same dirs, the same step, the same generator), and
// `emit-manifest.ts` imports `corpus` and `build` from this module. Two differences, both on purpose: a file is built
// with its DECK's resolver, role and lean rules (what the CLI hands `compile`, task/term/step-census.ts), not the bare
// stdlib resolver, which refused half of deck/make and deck/call; and its generated loop programs are not copied.
//
// Exit 0 unless a stage asked for with --expect-zero holds sharing or a misstamped place (then 1), or usage (2).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'

type Node = Record<string, any>

// ---- the corpus ----

export type Unit = { file: string; text: string }

// The exact generator (item 0201, T054): the float form `state * 1103515245 + 12345` loses its low bits once the product
// passes 2^53 and cycles early, so a "random" pick repeated itself. It is the generator of pair-intervals.ts, which
// must stay the same recurrence or the two corpora differ.
export function lcg(seed: number): () => number {
  let state = seed
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
    return state / 2147483648
  }
}

// what the last `corpus()` drew at random and how many of the draws were distinct files (printed beside the corpus)
export const drawn = { draws: 0, distinct: 0 }

function treeFiles(dir: string, out: string[]): void {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'host' || name === 'tmp' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) treeFiles(full, out)
    else if (name.endsWith('.tree')) out.push(full)
  }
}

const DIRS = ['deck/base/code', 'deck/make/code', 'deck/test/code', 'deck/call/code', 'deck/site/code', 'deck/mark', 'test']

// With `sample`: every mark benchmark, then files drawn without repeats by the seeded generator, `sample` in all. Without
// it, pair-intervals' own picks: every 1/800th file, the marks, and 80 random files (a file may stand twice there, and
// here once). Paths are relative to the Term package root, the way the harness runs.
export function corpus(options: { sample?: number; seed: number }): Unit[] {
  const files: string[] = []
  for (const dir of DIRS) treeFiles(dir, files)
  const marks: string[] = []
  treeFiles('deck/mark', marks)
  const random = lcg(options.seed)
  const wanted: string[] = []
  const seen = new Set<string>()
  const want = (file: string) => {
    if (!seen.has(file)) {
      seen.add(file)
      wanted.push(file)
    }
  }
  const draws = new Set<string>()
  drawn.draws = 0
  if (options.sample === undefined) {
    const step = Math.max(1, Math.floor(files.length / 800))
    for (let i = 0; i < files.length; i += step) want(files[i]!)
    for (const file of marks) want(file)
    for (let i = 0; i < 80; i++) {
      const file = files[Math.floor(random() * files.length)]!
      drawn.draws++
      draws.add(file)
      want(file)
    }
  } else {
    for (const file of marks) if (wanted.length < options.sample) want(file)
    const rest = files.filter(f => !seen.has(f))
    while (wanted.length < options.sample && rest.length > 0) {
      const at = Math.floor(random() * rest.length)
      drawn.draws++
      draws.add(rest[at]!)
      want(rest[at]!)
      rest.splice(at, 1)
    }
  }
  drawn.distinct = draws.size
  return wanted.map(file => ({ file, text: readFileSync(file, 'utf8') }))
}

export type Env = 'node' | 'rust' | 'swift' | 'kotlin'

// What the CLI hands `compile` for a file of a deck (call/code/test-native.ts, task/term/step-census.ts): the deck's own
// resolver for the target, its role and lean rules, and the deck of each file. The deck is the nearest folder holding a
// `deck.tree`, else the package root the harness runs in.
type Setup = { resolve: ReturnType<typeof projectResolver>; roleOf: (file: string) => any; leanOf: (file: string) => any; deckOf: any }

const setups = new Map<string, Setup>()

function rootOf(file: string): string {
  let dir = dirname(resolvePath(file))
  const top = process.cwd()
  while (dir.startsWith(top) && dir !== top) {
    if (existsSync(join(dir, 'deck.tree'))) return dir
    dir = dirname(dir)
  }
  return top
}

function setupOf(root: string, env: Env): Setup {
  const key = `${root} ${env}`
  let found = setups.get(key)
  if (!found) {
    found = {
      resolve: projectResolver(root, env),
      roleOf: projectRoleOf(root),
      leanOf: projectLeanOf(root),
      deckOf: projectDeckOf(),
    }
    setups.set(key, found)
  }
  return found
}

export type Built = { program?: Node[]; typescript?: string; reason?: string }

export function build(unit: Unit, optimize: boolean, env: Env = 'node'): Built {
  try {
    const file = resolvePath(unit.file)
    const setup = setupOf(rootOf(file), env)
    const whole = compile({ file, text: unit.text }, { ...setup, library: true, env, ...(optimize ? {} : { optimize: false }) } as never) as {
      ok: boolean
      program?: Node[]
      typescript?: string
      diagnostics?: { message: string }[]
    }
    if (!whole.ok) return { reason: whole.diagnostics?.[0]?.message ?? 'not ok' }
    if (!whole.program?.length) return { reason: 'empty program' }
    return { program: whole.program, typescript: whole.typescript }
  } catch (error) {
    return { reason: `threw ${(error as Error).message}` }
  }
}

// ---- the walk: compile/place-walk.tree in TypeScript ----

export type Row = { node: Node; root: Node | undefined }

export function placesOf(program: Node[]): Row[] {
  const rows: Row[] = []
  let root: Node | undefined

  const type = (node: Node | undefined): void => {
    if (!node || typeof node !== 'object') return
    switch (node.kind) {
      case 'array':
        type(node.element)
        break
      case 'map':
        type(node.key)
        type(node.value)
        break
      case 'named':
        for (const one of node.args ?? []) type(one)
        for (const one of node.valueArgs ?? []) expr(one)
        break
      case 'function':
        for (const one of node.params ?? []) type(one)
        type(node.result)
        break
    }
  }

  const exprs = (list: Node[] | undefined): void => {
    for (const one of list ?? []) expr(one)
  }

  const fields = (list: Node[] | undefined): void => {
    for (const one of list ?? []) expr(one.value)
  }

  const expr = (node: Node | undefined): void => {
    if (!node || typeof node !== 'object') return
    rows.push({ node, root })
    switch (node.form) {
      case 'template':
        for (const part of node.parts ?? []) {
          if (typeof part === 'string' || part === null || typeof part !== 'object') continue
          if (part.form === 'chunk') continue
          if (part.form === 'value') expr(part.value)
          else expr(part)
        }
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
        break
      case 'call':
        expr(node.callee)
        exprs(node.args)
        type(node.into)
        break
      case 'array':
        exprs(node.items)
        break
      case 'map':
        for (const entry of node.entries ?? []) {
          expr(entry.key)
          expr(entry.value)
        }
        break
      case 'record':
        fields(node.fields)
        exprs(node.positional)
        break
      case 'member':
        expr(node.target)
        expr(node.index)
        break
      case 'await':
        expr(node.expr)
        break
      case 'closure':
        block(node.body)
        type(node.result)
        break
      case 'conditional':
        for (const branch of node.branches ?? []) {
          expr(branch.cond)
          expr(branch.value)
        }
        expr(node.otherwise)
        break
    }
  }

  const block = (list: Node[] | undefined): void => {
    for (const one of list ?? []) stmt(one)
  }

  const signature = (given: Node | undefined): void => {
    if (given) type(given.result)
  }

  const extended = (given: Node | undefined): void => {
    if (!given) return
    type(given.base)
    for (const one of given.links ?? []) expr(one.fallback)
    fields(given.pins)
  }

  const calls = (list: Node[] | undefined): void => {
    for (const one of list ?? []) for (const arg of one.args ?? []) expr(arg.value)
  }

  const sends = (list: Node[] | undefined): void => {
    for (const one of list ?? []) expr(one.value)
  }

  const route = (given: Node | undefined): void => {
    if (!given) return
    for (const method of given.methods ?? []) {
      calls(method.calls)
      sends(method.sends)
    }
    calls(given.calls)
    if (given.component) for (const arg of given.component.props ?? []) expr(arg.value)
    sends(given.directives)
    sends(given.sends)
    for (const hook of given.hooks ?? []) calls(hook.calls)
    for (const child of given.children ?? []) route(child)
  }

  const views = (list: Node[] | undefined): void => {
    for (const one of list ?? []) view(one)
  }

  const view = (one: Node): void => {
    switch (one.form) {
      case 'element':
        for (const attribute of one.attributes ?? []) expr(attribute.value)
        fields(one.props)
        views(one.children)
        break
      case 'read':
      case 'save':
      case 'call':
        expr(one.value)
        break
      case 'fork':
        for (const branch of one.branches ?? []) {
          expr(branch.cond)
          views(branch.body)
        }
        for (const inner of one.otherwise ?? []) view(inner)
        break
      case 'walk':
        expr(one.iterable)
        views(one.body)
        break
    }
  }

  const stmt = (node: Node | undefined): void => {
    if (!node || typeof node !== 'object') return
    rows.push({ node, root })
    switch (node.form) {
      case 'let':
        expr(node.init)
        break
      case 'assign':
        expr(node.target)
        expr(node.value)
        break
      case 'expression':
        expr(node.expr)
        break
      case 'if':
        for (const branch of node.branches ?? []) {
          expr(branch.cond)
          block(branch.body)
        }
        block(node.otherwise)
        break
      case 'while':
        expr(node.cond)
        block(node.body)
        exprs(node.must)
        expr(node.down)
        break
      case 'match':
        expr(node.subject)
        for (const arm of node.cases ?? []) block(arm.body)
        block(node.otherwise)
        break
      case 'for-each':
        expr(node.iterable)
        block(node.body)
        exprs(node.must)
        break
      case 'return':
        expr(node.value)
        break
      case 'guard':
        block(node.body)
        if (node.catch) block(node.catch.body)
        break
      case 'throw':
        expr(node.value)
        break
      case 'hold':
        expr(node.expr)
        break
      case 'function':
        for (const param of node.params ?? []) expr(param.fallback)
        block(node.body)
        type(node.result)
        stmt(node.stubShape)
        block(node.stubBody)
        for (const universal of node.universals ?? []) expr(universal.expr)
        exprs(node.have)
        exprs(node.must)
        expr(node.down)
        signature(node.declared)
        break
      case 'record-type':
        for (const field of node.fields ?? []) expr(field.fallback)
        for (const variant of node.variants ?? []) exprs(variant.indexValues)
        type(node.alias)
        extended(node.extend)
        fields(node.pins)
        break
      case 'mask':
        for (const one of node.tasks ?? []) signature(one.signature)
        break
      case 'bind':
        type(node.result)
        break
      case 'view':
        views(node.body)
        break
      case 'dock':
        route(node.route)
        break
    }
  }

  for (const one of program) {
    root = one
    stmt(one)
  }
  return rows
}

// ---- the census ----

export type Census = {
  places: number
  shared: Map<Node, number>
  sharedPlaces: number
  firstShared: { root: string } | undefined
  misstamped: number
}

function rootName(root: Node | undefined): string {
  if (!root) return '(none)'
  return `${root.form}${typeof root.name === 'string' ? ` ${root.name}` : ''}`
}

export function census(program: Node[], stamped: boolean): Census {
  const rows = placesOf(program)
  const standing = new Map<Node, number>()
  let firstShared: Census['firstShared']
  let misstamped = 0
  rows.forEach((row, at) => {
    const was = standing.get(row.node) ?? 0
    standing.set(row.node, was + 1)
    if (was === 1 && !firstShared) firstShared = { root: rootName(row.root) }
    if (stamped && row.node.placeRow !== at + 1) misstamped++
  })
  const shared = new Map<Node, number>()
  let sharedPlaces = 0
  for (const [node, count] of standing) {
    if (count >= 2) {
      shared.set(node, count)
      sharedPlaces += count
    }
  }
  return { places: rows.length, shared, sharedPlaces, firstShared, misstamped }
}

// ---- the attribution (--where) ----

// object -> the key paths that reach it, rooted at the top statement's form, indices dropped (`[]`), a node's `span` and
// `type` never entered. This is the grouping of the item 0193 probe (tmp/probe-0193/attribute.ts). It is reflective on
// purpose (a holding path may run through a field the place walk does not name, such as a pin record's `value`), and its
// keys are taken in sorted order, never `Object.keys` order, so a report does not move with how a pass built an object.
// A node's children are walked on its first standing only, as the probe does.
export function contexts(program: Node[]): Map<object, string[]> {
  const out = new Map<object, string[]>()
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const one of value) walk(one, `${path}[]`)
      return
    }
    const node = value as Record<string, unknown>
    const at = typeof node.form === 'string' ? `${path}<${node.form}>` : path
    const list = out.get(node) ?? []
    list.push(at)
    out.set(node, list)
    if (list.length > 1) return
    for (const key of Object.keys(node).sort()) {
      if (key === 'span' || key === 'type') continue
      walk(node[key], `${at}.${key}`)
    }
  }
  for (const one of program) walk(one, `${one.form}`)
  return out
}

const tail = (path: string): string => path.split('.').slice(-3).join('.')

type Group = { objects: number; places: number; files: Set<string>; example: string }

const WHERE_LINES = 15

// one line per group (form and the set of last-three-key paths), largest first, WHERE_LINES lines at most
function printWhere(stage: string, groups: Map<string, Group>, objects: number): void {
  const rows = [...groups].sort((a, b) => b[1].objects - a[1].objects || b[1].places - a[1].places || (a[0] < b[0] ? -1 : 1))
  const room = WHERE_LINES - 1
  const shown = rows.length > room ? rows.slice(0, room - 1) : rows
  console.log(`where ${stage}: ${objects} shared objects in ${rows.length} groups`)
  for (const [key, group] of shown) {
    console.log(`  ${group.objects} objects, ${group.places} places, ${group.files.size} files: ${key}, e.g. ${group.example}`)
  }
  if (shown.length < rows.length) {
    let objectsLeft = 0
    for (const [, group] of rows.slice(shown.length)) objectsLeft += group.objects
    console.log(`  ... ${rows.length - shown.length} more groups, ${objectsLeft} objects`)
  }
}

// ---- the report ----

type Stage = 'checked' | 'lowered' | 'stamped'

type Smallest = { file: string; places: number; root: string }

type Totals = {
  stage: Stage
  programs: number
  places: number
  shared: number
  sharedPlaces: number
  misstamped: number
  forms: Map<string, number>
  smallest: Smallest | undefined
  modules: string[]
  skipped: string | undefined
  notBuilt: number
  reasons: Map<string, number>
}

const USAGE =
  'usage: shared-nodes.ts [--stage checked|lowered|stamped|all] [--sample N] [--seed S] [--expect-zero <stage>] [--modules <stage>] [--where <stage>]'

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

async function stamper(): Promise<{ stamp?: (program: Node[]) => Node[]; reason?: string }> {
  try {
    // SHARED_NODES_STAMP names another module (an absolute path) exporting `stampPlaces`: how this tool's own stamped
    // stage is tested before compile/place-stamp exists
    const path = process.env.SHARED_NODES_STAMP ?? '@term/make/code/compile/place-stamp'
    const loaded = (await (process.env.SHARED_NODES_STAMP ? import(path) : import('@term/make/code/compile/place-stamp'))) as { stampPlaces?: (program: Node[]) => Node[]; default?: { stampPlaces?: (program: Node[]) => Node[] } }
    const stampPlaces = loaded.stampPlaces ?? loaded.default?.stampPlaces
    if (typeof stampPlaces !== 'function') return { reason: `${path} has no stampPlaces` }
    return { stamp: stampPlaces }
  } catch (error) {
    return { reason: `compile/place-stamp could not be loaded: item 0038 writes it (${(error as Error).message.split('\n')[0]})` }
  }
}

function notBuilt(total: Totals, reason: string | undefined): void {
  total.notBuilt++
  const why = (reason ?? 'unknown').slice(0, 100)
  total.reasons.set(why, (total.reasons.get(why) ?? 0) + 1)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let stageFlag = 'all'
  let sample: number | undefined
  let seed = 9137
  let expectZero: string | undefined
  let modulesOf: string | undefined
  let whereOf: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--stage') stageFlag = value ?? usage('--stage needs a value')
    else if (flag === '--sample') sample = Number(value)
    else if (flag === '--seed') seed = Number(value)
    else if (flag === '--expect-zero') expectZero = value ?? usage('--expect-zero needs a stage')
    else if (flag === '--modules') modulesOf = value ?? usage('--modules needs a stage')
    else if (flag === '--where') whereOf = value ?? usage('--where needs a stage')
    else usage(`unknown flag ${flag}`)
    i++
  }
  const stages: Stage[] = ['checked', 'lowered', 'stamped']
  if (stageFlag !== 'all' && !stages.includes(stageFlag as Stage)) usage(`unknown stage ${stageFlag}`)
  for (const named of [expectZero, modulesOf, whereOf]) if (named !== undefined && !stages.includes(named as Stage)) usage(`unknown stage ${named}`)
  if (sample !== undefined && !(sample > 0)) usage('--sample needs a positive number')
  if (!Number.isFinite(seed)) usage('--seed needs a number')

  const wanted = new Set<Stage>(stageFlag === 'all' ? stages : [stageFlag as Stage])
  if (expectZero) wanted.add(expectZero as Stage)
  if (modulesOf) wanted.add(modulesOf as Stage)
  if (whereOf) wanted.add(whereOf as Stage)
  if (wanted.has('stamped')) wanted.add('lowered')

  const units = corpus({ sample, seed })
  const stamp = wanted.has('stamped') ? await stamper() : {}
  const totals = new Map<Stage, Totals>()
  for (const stage of stages) {
    totals.set(stage, {
      stage,
      programs: 0,
      places: 0,
      shared: 0,
      sharedPlaces: 0,
      misstamped: 0,
      forms: new Map(),
      smallest: undefined,
      modules: [],
      skipped: stage === 'stamped' ? stamp.reason : undefined,
      notBuilt: 0,
      reasons: new Map(),
    })
  }

  const groups = new Map<string, Group>()
  let whereObjects = 0

  const record = (stage: Stage, unit: Unit, program: Node[], stamped: boolean) => {
    const total = totals.get(stage)!
    const one = census(program, stamped)
    total.programs++
    total.places += one.places
    total.shared += one.shared.size
    total.sharedPlaces += one.sharedPlaces
    total.misstamped += one.misstamped
    if (one.shared.size > 0) {
      total.modules.push(unit.file)
      for (const node of one.shared.keys()) total.forms.set(String(node.form), (total.forms.get(String(node.form)) ?? 0) + 1)
      if (!total.smallest || one.places < total.smallest.places) {
        total.smallest = { file: unit.file, places: one.places, root: one.firstShared?.root ?? '(none)' }
      }
      if (stage === whereOf) {
        const where = contexts(program)
        for (const [node, count] of one.shared) {
          whereObjects++
          const paths = where.get(node) ?? ['(not reached reflectively)']
          const key = `${node.form} @ ${[...new Set(paths.map(tail))].sort().join(' | ')}`
          const group = groups.get(key) ?? { objects: 0, places: 0, files: new Set<string>(), example: unit.file }
          group.objects++
          group.places += count
          group.files.add(unit.file)
          groups.set(key, group)
        }
      }
    }
  }

  for (const unit of units) {
    if (wanted.has('checked')) {
      const built = build(unit, false)
      if (built.program) record('checked', unit, built.program, false)
      else notBuilt(totals.get('checked')!, built.reason)
    }
    if (wanted.has('lowered')) {
      const built = build(unit, true)
      if (built.program) {
        record('lowered', unit, built.program, false)
        if (wanted.has('stamped') && stamp.stamp) {
          try {
            record('stamped', unit, stamp.stamp(built.program), true)
          } catch (error) {
            totals.get('stamped')!.notBuilt++
            totals.get('stamped')!.skipped = `stampPlaces threw ${(error as Error).message}`
          }
        }
      } else {
        notBuilt(totals.get('lowered')!, built.reason)
      }
    }
  }

  if (modulesOf) {
    for (const file of totals.get(modulesOf as Stage)!.modules) console.log(file)
    return
  }

  console.log(`SHARED-NODES corpus ${units.length} files, seed ${seed}${sample === undefined ? '' : `, sample ${sample}`}`)
  console.log(`  census: ${drawn.draws} random draws, ${drawn.distinct} distinct files; ${units.length} distinct files in the corpus`)
  // an empty corpus, or the default one with no random draw in it, proves nothing (a sample no bigger than the marks draws none)
  let failed = units.length === 0 || (sample === undefined && drawn.distinct === 0)
  const shown = new Set<string>(stageFlag === 'all' ? stages : [stageFlag])
  if (expectZero) shown.add(expectZero)
  for (const stage of stages) {
    if (!shown.has(stage)) continue
    const total = totals.get(stage)!
    console.log(`stage ${stage}`)
    if (total.skipped && total.programs === 0) {
      console.log(`  skipped: ${total.skipped}`)
      continue
    }
    console.log(`  programs:       ${total.programs} (${total.notBuilt} files not built)`)
    for (const [why, count] of [...total.reasons].sort((x, y) => y[1] - x[1]).slice(0, 2)) console.log(`    not built ${count}x ${why}`)
    console.log(`  places:         ${total.places}`)
    console.log(`  shared objects: ${total.shared}`)
    console.log(`  shared places:  ${total.sharedPlaces}`)
    if (stage === 'stamped') console.log(`  misstamped:     ${total.misstamped}`)
    const top = [...total.forms].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10)
    console.log(`  top forms:      ${top.length ? top.map(([form, count]) => `${form} ${count}`).join(', ') : '(none)'}`)
    console.log(
      `  smallest:       ${total.smallest ? `${total.smallest.file}, task ${total.smallest.root}, ${total.smallest.places} places` : '(no program shares)'}`,
    )
  }
  if (whereOf) {
    const total = totals.get(whereOf as Stage)!
    if (total.skipped && total.programs === 0) console.log(`where ${whereOf}: skipped: ${total.skipped}`)
    else printWhere(whereOf, groups, whereObjects)
  }
  if (expectZero) {
    const total = totals.get(expectZero as Stage)!
    if (total.skipped && total.programs === 0) failed = true
    else if (total.shared > 0 || total.misstamped > 0) failed = true
    console.log(
      `expect-zero ${expectZero}: ${total.shared} shared objects, ${total.misstamped} misstamped${total.skipped && total.programs === 0 ? ` (skipped: ${total.skipped})` : ''}`,
    )
    console.log(`status: ${failed ? 'FAIL' : 'PASS'}`)
  }
  process.exit(failed ? 1 : 0)
}

if (process.argv[1]?.endsWith('shared-nodes.ts')) {
  main().catch(error => {
    console.error(error)
    process.exit(2)
  })
}
