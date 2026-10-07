// Differential admission (note/term/optimize/admission.md, optimize-0010): does each twin AGREE with its task?
//
// A twin is another implementation of a task the compiler may choose in its place. Before the kernel can prove that
// (optimize-0019), this is the evidence: the twin and its task run on the same inputs and must give the same answer
// wherever the twin's conditions (`have`, `hook test`) hold. A twin that agrees is admitted as TESTED, with the count,
// never as proven.
//
//   1. inputs are GENERATED from the task's signature, biased to what breaks code that counts and indexes: empty and
//      one-item lists, duplicates, sorted runs, the integers 0 and -1, and every integer literal in the twin's
//      conditions together with the ones either side of it (for `dense`, 65535, 65536 and 65537)
//   2. the TypeScript build runs in this process, so thousands of inputs cost seconds
//   3. a disagreement is SHRUNK to the smallest input that still disagrees, and printed as a Term literal
//   4. every run also builds MUTANTS of the twin (a literal off by one, a comparison flipped) and must catch them: a run
//      that cannot tell a wrong twin from a right one is not evidence, and says so instead of admitting
//   5. the same inputs replay on Rust, Swift and Kotlin with the real toolchains, so a twin that agrees in JavaScript
//      and not in i64 arithmetic is caught (twin-diff's `native`)
//
// A type with no generator (a form, a closure, a native handle) refuses admission with the type named, rather than
// running a test that never reaches the twin.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'
import type { Statement, Twin, Type } from '@term/make/code/compile/node'
import { guardTask, twinTask } from '@term/make/code/ir/twin'
import { isTestTwin } from '@term/make/code/check/twin'

type Fn = Extract<Statement, { form: 'function' }>

export type Disagreement = {
  input: unknown[]
  // the input written as Term, to paste into a test
  literal: string
  reference: string
  twin: string
}

export type Verdict = {
  task: string
  twin: string
  // generated inputs, and how many of them met the twin's conditions (the ones actually compared)
  cases: number
  compared: number
  disagreement?: Disagreement
  // mutants built and how many the comparison caught
  mutants: { built: number; caught: number }
  // per native target: agreed on N replayed inputs, or why it could not run
  native: Record<string, string>
  // admitted as tested: agreed everywhere, compared enough inputs, and caught at least one mutant
  admitted: boolean
  reason: string
}

// a small seeded generator, so a run is the same run every time
function random(seed: number): () => number {
  let state = seed >>> 0 || 1

  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5

    return (state >>> 0) / 4294967296
  }
}

// every integer literal in an expression: the boundaries a condition draws
function integersIn(node: unknown, into = new Set<number>()): Set<number> {
  if (Array.isArray(node)) {
    node.forEach(n => integersIn(n, into))
  } else if (node && typeof node === 'object') {
    const n = node as { form?: string; value?: unknown }

    if (n.form === 'integer' && typeof n.value === 'number') {
      into.add(n.value)
    }

    for (const [key, value] of Object.entries(node)) {
      if (key !== 'span' && key !== 'type') {
        integersIn(value, into)
      }
    }
  }

  return into
}

type Gen = (next: () => number) => unknown

function generatorFor(type: Type | undefined, boundaries: number[]): Gen | string {
  switch (type?.kind) {
    case 'number': {
      const near = [0, 1, -1, 2, 3, ...boundaries.flatMap(b => [b - 1, b, b + 1])]

      return next => {
        const roll = next()

        if (roll < 0.45) {
          return near[Math.floor(next() * near.length)]
        }

        if (roll < 0.9) {
          return Math.floor(next() * 12) - 2
        }

        return Math.floor(next() * 2_000_001) - 1_000_000
      }
    }

    case 'float':
      return next => {
        const roll = next()

        return roll < 0.1 ? 0 : roll < 0.15 ? -0 : roll < 0.2 ? 0.5 : (next() - 0.5) * 2000
      }

    case 'boolean':
      return next => next() < 0.5

    case 'string':
      return next => {
        const length = Math.floor(next() * 5)

        return Array.from({ length }, () => 'abcxyz'[Math.floor(next() * 6)]).join('')
      }

    case 'array': {
      const item = generatorFor(type.element, boundaries)

      if (typeof item === 'string') {
        return item
      }

      return next => {
        const roll = next()
        const length = roll < 0.12 ? 0 : roll < 0.25 ? 1 : Math.floor(next() * 12)
        const items = Array.from({ length }, () => item(next))

        // a run of duplicates, and a sorted list, are what break code that counts and searches
        if (length > 2 && next() < 0.25) {
          items[1] = items[0]
          items[length - 1] = items[0]
        }

        if (length > 1 && next() < 0.15) {
          items.sort((a, b) => (a as number) - (b as number))
        }

        return items
      }
    }

    case 'named':
      if (type.name === 'text') {
        return generatorFor({ kind: 'string' }, boundaries)
      }

      if (type.name === 'boolean') {
        return generatorFor({ kind: 'boolean' }, boundaries)
      }

      if (type.name === 'list' && type.args?.[0]) {
        return generatorFor({ kind: 'array', element: type.args[0] }, boundaries)
      }

      return `no generator for \`${type.name}\``

    default:
      return `no generator for a ${type?.kind ?? 'missing'} type`
  }
}

// structural equality as Term means it (`__termEqual`), with `Object.is` for a float: NaN is NaN, and -0 is not 0
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b) || a === b
  }

  if (a === b) {
    return true
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i]))
  }

  if (a instanceof Map && b instanceof Map) {
    return a.size === b.size && [...a].every(([k, v]) => b.has(k) && same(v, b.get(k)))
  }

  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)

    return ka.length === Object.keys(b).length && ka.every(k => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }

  return false
}

type Outcome = { value: unknown } | { raise: string }

function outcomeOf(run: () => unknown): Outcome {
  try {
    return { value: run() }
  } catch (error) {
    const e = error as { form?: string; name?: string; message?: string }

    return { raise: e.form ?? e.name ?? String(e) }
  }
}

const agree = (a: Outcome, b: Outcome): boolean =>
  'value' in a && 'value' in b ? same(a.value, b.value) : 'raise' in a && 'raise' in b ? a.raise === b.raise : false

const show = (o: Outcome): string => ('value' in o ? JSON.stringify(o.value instanceof Map ? [...o.value] : o.value) : `raises ${o.raise}`)

// a JavaScript value as the Term that builds it, for a disagreement a person pastes into a test
function literal(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(literal).join(', ')}]`
  }

  if (typeof value === 'string') {
    return `text <${value}>`
  }

  return String(value)
}

// smaller inputs first: drop a list item, then move a number toward zero, while the disagreement still holds
function shrink(input: unknown[], fails: (input: unknown[]) => boolean): unknown[] {
  let best = input
  let progress = true

  while (progress) {
    progress = false

    for (let p = 0; p < best.length && !progress; p++) {
      const value = best[p]
      const candidates: unknown[] = []

      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          candidates.push([...value.slice(0, i), ...value.slice(i + 1)])
        }

        value.forEach((item, i) => {
          if (typeof item === 'number' && item !== 0) {
            for (const smaller of [0, Math.trunc(item / 2), item - Math.sign(item)]) {
              candidates.push(value.map((x, j) => (j === i ? smaller : x)))
            }
          }
        })
      } else if (typeof value === 'number' && value !== 0) {
        candidates.push(0, Math.trunc(value / 2), value - Math.sign(value))
      }

      for (const candidate of candidates) {
        const next = best.map((x, i) => (i === p ? candidate : x))

        if (fails(next)) {
          best = next
          progress = true
          break
        }
      }
    }
  }

  return best
}

// the mutants of a twin: each integer literal off by one, each comparison flipped, each `+` a `-`. A mutant that
// happens to mean the same thing is not caught, which is why admission asks for at least one caught, not all
function mutantsOf(twin: Twin): ((t: Twin) => void)[] {
  const sites: ((t: Twin) => void)[] = []
  const flips: Record<string, string> = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==', '+': '-', '-': '+' }
  let count = 0

  const walk = (node: unknown, path: (string | number)[]): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, [...path, i]))

      return
    }

    if (!node || typeof node !== 'object') {
      return
    }

    const n = node as { form?: string; value?: unknown; op?: string }
    const at = (t: Twin): Record<string, unknown> => path.reduce((o: any, k) => o[k], t.body as unknown) as Record<string, unknown>

    if (n.form === 'integer' && typeof n.value === 'number' && count < 24) {
      count++
      sites.push(t => {
        const target = at(t) as { value: number }
        target.value += 1
      })
    }

    if (n.form === 'binary' && n.op && flips[n.op] && count < 24) {
      count++
      sites.push(t => {
        const target = at(t) as { op: string }
        target.op = flips[target.op]!
      })
    }

    for (const [key, value] of Object.entries(node)) {
      if (key !== 'span' && key !== 'type') {
        walk(value, [...path, key])
      }
    }
  }

  walk(twin.body, [])

  return sites
}

const camel = (name: string): string => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

// one compile cache for the whole run: a mutant differs from the module only after milling, so every module of the
// stdlib closure is read and milled once, not once per mutant (a 2026-10-02 run took fifteen minutes without it)
export const cache = new CompileCache()

// build the module with its twins exposed, and write its TypeScript where a child process can load it
function load(
  source: { file: string; text: string },
  resolve: Resolver,
  dir: string,
  adjust?: (twins: Twin[]) => Twin[],
): { module: string; program: Statement[]; twins: Twin[] } | string {
  const built = compile(source, { resolve, cache, exposeTwins: true, ...(adjust ? { adjustTwins: adjust } : {}) })

  if (!built.ok) {
    return built.diagnostics.map(d => d.message).join(' | ')
  }

  const module = join(dir, `module-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(module, built.typescript)

  return { module, program: built.program, twins: built.twins ?? [] }
}

export type Comparison = { compared: number; first?: unknown[]; disagreement?: Omit<Disagreement, 'literal'> }

// compare a built twin with its task on `cases`, wherever the twin's conditions hold, and shrink the first
// disagreement when asked. Runs in the CHILD process (`compareInChild`), never in the one that called admit
export async function compareModule(input: {
  module: string
  of: string
  label: string
  cases: unknown[][]
  shrink: boolean
}): Promise<Comparison> {
  const module = (await import(pathToFileURL(input.module).href)) as Record<string, (...args: unknown[]) => unknown>
  const ref = module[camel(input.of)]!
  const alt = module[camel(twinTask(input.of, input.label))]!
  const guard = module[camel(guardTask(input.of, input.label))]!
  const holds = (args: unknown[]): boolean => {
    const admitted = outcomeOf(() => guard(...structuredClone(args)))

    return 'value' in admitted && admitted.value === true
  }
  const fails = (args: unknown[]): boolean =>
    holds(args) && !agree(outcomeOf(() => ref(...structuredClone(args))), outcomeOf(() => alt(...structuredClone(args))))
  let compared = 0

  for (const args of input.cases) {
    if (!holds(args)) {
      continue
    }

    compared++

    if (fails(args)) {
      if (!input.shrink) {
        return { compared, first: args }
      }

      const small = shrink(args, fails)

      return {
        compared,
        first: args,
        disagreement: {
          input: small,
          reference: show(outcomeOf(() => ref(...structuredClone(small)))),
          twin: show(outcomeOf(() => alt(...structuredClone(small)))),
        },
      }
    }
  }

  return { compared }
}

// run `compareModule` in a child process with a time limit. One that does not finish in time is reported as such: a
// twin, or a mutant, that never returns where its task returns is a wrong answer, never a pass
function compareInChild(
  dir: string,
  input: Parameters<typeof compareModule>[0],
  seconds: number,
): Comparison | { timedOut: true } | { failed: string } {
  // `.mts`: an ES module whatever the directory around it says, so its top-level `await` runs
  const runner = join(dir, 'compare-runner.mts')
  const request = join(dir, `request-${Math.random().toString(36).slice(2)}.json`)

  writeFileSync(
    runner,
    `import { readFileSync } from 'node:fs'
import { compareModule } from ${JSON.stringify(fileURLToPath(import.meta.url))}
const result = await compareModule(JSON.parse(readFileSync(process.argv[2]!, 'utf8')))
process.stdout.write(JSON.stringify(result))
`,
  )
  writeFileSync(request, JSON.stringify(input))

  const ran = spawnSync('npx', ['tsx', runner, request], {
    encoding: 'utf8',
    timeout: seconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
    cwd: join(fileURLToPath(import.meta.url), '../../../..'),
  })

  if (ran.error && (ran.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { timedOut: true }
  }

  if (ran.signal) {
    return { timedOut: true }
  }

  try {
    return JSON.parse(ran.stdout.trim().split('\n').pop() ?? '') as Comparison
  } catch {
    return { failed: (ran.stderr || ran.stdout).split('\n').filter(l => /Error|error/.test(l)).slice(0, 3).join(' | ').slice(0, 300) }
  }
}

export async function admit(input: {
  source: { file: string; text: string }
  resolve: Resolver
  // scratch, for the emitted modules and native builds
  dir: string
  cases?: number
  seed?: number
  // how many of the cases replay on each native toolchain (0 skips the native replay)
  native?: number
  // seconds one comparison may take before it counts as not returning
  limit?: number
  // how many deliberately wrong copies of each twin to build (each is a whole compile); default 8
  mutants?: number
  // the native build for one env: emitted source text and how to run it, supplied by the caller so this module does
  // not reach into the CLI's toolchain handling
  nativeRun?: (env: 'rust' | 'swift' | 'kotlin', text: string) => { ok: true; out: string } | { ok: false; why: string }
}): Promise<{ ok: true; verdicts: Verdict[] } | { ok: false; reason: string }> {
  mkdirSync(input.dir, { recursive: true })

  const loaded = load(input.source, input.resolve, input.dir)

  if (typeof loaded === 'string') {
    return { ok: false, reason: `the module does not build: ${loaded}` }
  }

  const verdicts: Verdict[] = []
  const count = input.cases ?? 2000
  const limit = input.limit ?? 120

  const pending: { verdict: Verdict; twin: Twin; reference: Fn; cases: unknown[][] }[] = []

  for (const twin of loaded.twins) {
    // a test twin stands in for a task in a test and is not claimed equivalent: nothing to compare (mocks spec 2.1)
    if (isTestTwin(twin)) {
      continue
    }

    const reference = loaded.program.find((s): s is Fn => s.form === 'function' && s.name === twin.of)
    const verdict: Verdict = {
      task: twin.of,
      twin: twin.name,
      cases: 0,
      compared: 0,
      mutants: { built: 0, caught: 0 },
      native: {},
      admitted: false,
      reason: '',
    }
    verdicts.push(verdict)

    if (!reference) {
      verdict.reason = `\`${twin.of}\` is not in the build`
      continue
    }

    const boundaries = [...integersIn([twin.have, twin.test])]
    const gens = reference.params.map(p => generatorFor(p.type, boundaries))
    const missing = gens.find((g): g is string => typeof g === 'string')

    if (missing) {
      verdict.reason = `cannot generate inputs: ${missing}`
      continue
    }

    const next = random(input.seed ?? 20261002)
    const inputs = Array.from({ length: count }, () => (gens as Gen[]).map(g => g(next)))
    verdict.cases = inputs.length

    process.stderr.write(`admit: ${twin.of}/${twin.name}: comparing ${inputs.length} inputs\n`)

    const result = compareInChild(input.dir, { module: loaded.module, of: twin.of, label: twin.name, cases: inputs, shrink: true }, limit)

    if ('timedOut' in result) {
      verdict.reason = `did not finish comparing in ${limit} s: a twin that never returns where its task does is a wrong answer`
      continue
    }

    if ('failed' in result) {
      verdict.reason = `the comparison could not run: ${result.failed}`
      continue
    }

    verdict.compared = result.compared

    if (result.disagreement) {
      verdict.disagreement = { ...result.disagreement, literal: result.disagreement.input.map(literal).join(', ') }
      verdict.reason = `disagrees on ${verdict.disagreement.literal}: \`${twin.of}\` gives ${verdict.disagreement.reference}, \`${twin.name}\` gives ${verdict.disagreement.twin}`
      continue
    }

    if (verdict.compared < Math.min(50, count / 10)) {
      verdict.reason = `only ${verdict.compared} of ${count} generated inputs met the twin's conditions, too few to be evidence`
      continue
    }

    // the mutants: a comparison that cannot catch a wrong twin proves nothing. One that never returns is caught
    const mutants = mutantsOf(twin).slice(0, input.mutants ?? 8)

    process.stderr.write(`admit: ${twin.of}/${twin.name}: ${mutants.length} mutants\n`)

    for (const mutate of mutants) {
      const mutant = load(input.source, input.resolve, input.dir, twins =>
        twins.map(t => {
          if (t.of === twin.of && t.name === twin.name) {
            mutate(t)
          }

          return t
        }),
      )

      if (typeof mutant === 'string') {
        continue
      }

      verdict.mutants.built++

      const judged = compareInChild(input.dir, { module: mutant.module, of: twin.of, label: twin.name, cases: inputs, shrink: false }, Math.min(limit, 30))

      if ('timedOut' in judged || ('first' in judged && judged.first)) {
        verdict.mutants.caught++
      }
    }

    if (verdict.mutants.built > 0 && verdict.mutants.caught === 0) {
      verdict.reason = `none of ${verdict.mutants.built} deliberately wrong copies of the twin was caught, so agreement here is not evidence`
      continue
    }

    // replayed natively below, with every other twin of the module, in one build per toolchain
    if (input.nativeRun && (input.native ?? 40) > 0) {
      pending.push({ verdict, twin, reference, cases: inputs.slice(0, input.native ?? 40) })
    }

    verdict.admitted = true
    verdict.reason = `agreed on ${verdict.compared} of ${verdict.cases} inputs that met its conditions, caught ${verdict.mutants.caught} of ${verdict.mutants.built} mutants`
  }

  // the native replay: every twin still admitted, the same inputs, ONE build per toolchain
  const replaying = pending.filter(p => p.verdict.admitted)

  if (input.nativeRun && replaying.length > 0) {
    const driver = nativeDriver(input.source.text, replaying)

    for (const env of ['rust', 'swift', 'kotlin'] as const) {
      if (driver.startsWith('\0')) {
        replaying.forEach(p => (p.verdict.native[env] = `not replayed: ${driver.slice(1)}`))
        continue
      }

      process.stderr.write(`admit: replaying ${replaying.length} twin(s) on ${env}\n`)

      const ran = input.nativeRun(env, driver)
      const counts = new Map(
        ran.ok ? [...ran.out.matchAll(/d(\d+)=(\d+)/g)].map(m => [Number(m[1]), Number(m[2])] as const) : [],
      )

      replaying.forEach((p, i) => {
        const disagreed = counts.get(i)

        p.verdict.native[env] = !ran.ok
          ? `not replayed: ${ran.why}`
          : disagreed === 0
            ? `agreed on ${p.cases.length}`
            : `DISAGREED on ${disagreed ?? '?'} of ${p.cases.length}`
      })
    }

    for (const p of replaying) {
      const native = Object.entries(p.verdict.native).find(([, v]) => v.startsWith('DISAGREED'))

      if (native) {
        p.verdict.admitted = false
        p.verdict.reason = `agrees in TypeScript and not on ${native[0]}: ${native[1]}`
      }
    }
  }

  return { ok: true, verdicts }
}

// a Term program that replays `cases` on a native backend: the module's own text, plus a `compute` task that runs the
// twin and its task on each case where the twin's conditions hold and prints how many disagreed. Lists of numbers
// and numbers only: anything else is not replayed natively, and says so ("\0" + why)
export const REPLAY_TASK = 'replay-compute'

export function nativeDriver(
  module: string,
  entries: { twin: Twin; reference: Fn; cases: unknown[][] }[],
): string {
  // each case is a task of its own answering 1 when the twin's conditions hold and the two disagree, else 0: a few
  // lines each, so the checker's work stays proportional to the cases rather than to their square
  const tasks: string[] = []
  const sums: string[] = []

  for (const [k, { twin, reference, cases }] of entries.entries()) {
    const kinds = reference.params.map(p =>
      p.type?.kind === 'number'
        ? 'number'
        : (p.type?.kind === 'array' && p.type.element.kind === 'number') ||
            (p.type?.kind === 'named' && p.type.name === 'list' && p.type.args?.[0]?.kind === 'number')
          ? 'list'
          : undefined,
    )

    if (kinds.some(kind => kind === undefined)) {
      return '\0the native replay covers numbers and lists of numbers'
    }

    const names: string[] = []

    cases.forEach((args, i) => {
      const name = `replay-${k}-${i}`
      names.push(name)
      const values = args.map((_, p) => `a${p}`)
      const lines = [`task ${name}`, '  like number']

      args.forEach((value, p) => {
        if (kinds[p] === 'number') {
          lines.push(`  host ${values[p]}, code ${value as number}`)
        } else {
          lines.push(`  save ${values[p]}`, '    make list')

          for (const item of value as number[]) {
            lines.push('  call push', `    bind list, read ${values[p]}`, `    bind item, code ${item}`)
          }
        }
      })

      // a call of `task` on this case's values, its first line at `depth` spaces
      const call = (task: string, depth: number): string[] => [
        `${' '.repeat(depth)}call ${task}`,
        ...values.map(v => `${' '.repeat(depth + 2)}read ${v}`),
      ]

      lines.push(
        '  fork test',
        '    hook test',
        ...call(guardTask(twin.of, twin.name), 6),
        '    hook hold',
        '      fork test',
        '        hook test',
        '          call is-unequal',
        ...call(twin.of, 12),
        ...call(twinTask(twin.of, twin.name), 12),
        '        hook hold',
        '          send back, code 1',
        '  send back, code 0',
      )

      tasks.push(lines.join('\n'))
    })

    sums.push(`  save d${k}, code 0`, ...names.flatMap(name => [`  save d${k}`, '    call add', `      read d${k}`, `      call ${name}`]))
  }

  const main = [`task ${REPLAY_TASK}`, '  like text', ...sums, `  send back, text <${entries.map((_, k) => `d${k}={{d${k}}}`).join(' ')}>`]

  return `${module}\n${tasks.join('\n\n')}\n\n${main.join('\n')}\n`
}
