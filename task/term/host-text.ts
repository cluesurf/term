// The host-text check of decision 113: is a .tree suite a port, or JavaScript in a string? Reads every `bind` body under
// the Term package's test/ folders (note/project/term/self-host/change/001-finish-self-host/decision/113-a-suite-is-tree-and-host-text-is-one-call.md).
// It was tmp/self-host/suite-host-text.mjs. Item term-self-host-001-0882 made it permanent, with the same rule and words.
//
//   pnpm term:host-text [path-prefix ...]          report, one line per file with anything to say, then the totals
//   pnpm term:host-text --fail [path-prefix ...]   exit 1 when a named suite holds a refused bind or a fact table. A batch runs this
//   pnpm term:host-text --items                    the refused files mapped to their SUITE batch (finding/suite-batches.json)
//   pnpm term:host-text --list <path>              every bind of one file with its verdict
//   pnpm term:host-text --ratchet                  exit 1 when the counts pass note/project/term/self-host/host-text.json (shrink only)
//   pnpm term:host-text --commit                   rewrite that baseline, refused if any count rose
//   --root <dir>                                   read another Term root's test/ (a fixture), and never the baseline
//
// A bind body is judged alone, one per `case <env>`:
//   call      one expression, at most 200 characters, no arrow: the host need the rule allows
//   arrow     one expression, at most 120 characters, a closure inside: counted, allowed until the sweep item ends, then refused
//   refused   a statement, a block, control flow, or too long. Logic: it goes in .tree. Unless the line above the bind says
//             `# host <word>: <reason>`, word from value, reflect, native, at most 400 characters, or subject in a file listed below
//             (decision 113 says what each covers)
// A file is also refused for a fact table: a test whose hold repeats the test's own title as a literal, reading a lookup, which is
// what makes every test read green without an assertion in it, or for running text as JavaScript (new Function, eval, node -e).
// test/support is reported apart. Item 0707 owns it, and its binds do not hold a suite.
// task/term/floor.ts prints the totals as one line, and gate 0152 (task/gates.md) requires refused 0, arrow 0, facts 0.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TERM_ROOT, parentRoot } from './root'

const REPO = TERM_ROOT
const TERM = TERM_ROOT
const BATCHES = (): string => join(parentRoot(), 'note/project/term/self-host/change/001-finish-self-host/finding/suite-batches.json')
const BASELINE = (): string => join(parentRoot(), 'note/project/term/self-host/host-text.json')

const CALL_LIMIT = 200
const ARROW_LIMIT = 120
const DECLARED_LIMIT = 400
const WORDS = ['value', 'reflect', 'native', 'subject']
// `subject` holds only here: a suite whose subject IS how a JavaScript value behaves. A file joins by a line of decision 113.
const SUBJECT = ['test/check/program-copy.tree']
const CONTROL = /\b(const|let|var|function|class|for|while|if|switch|try|catch|return|throw)\b/
const ARROW = /=\\?>/
const BLOCK = /=\\?>\s*\\?\{/
const RUNS_TEXT = /new Function\b|\beval\(|<-e>|\bvm\.run/

export type Verdict = 'call' | 'arrow' | 'refused' | 'declared'

type Bind = { name: string; size: number; verdict: Verdict; why: string; text: string }

export type Row = {
  file: string
  tests: number
  binds: Array<Bind>
  host: number
  call: number
  arrow: number
  refused: number
  refusedChars: number
  declared: number
  facts: number
  runs: boolean
  whole: number
}

export type Total = {
  suites: number
  host: number
  call: number
  arrow: number
  refused: number
  refusedChars: number
  declared: number
  facts: number
  heldFiles: number
  supportHost: number
  supportRefused: number
}

// strings out first, so a word inside a quoted fixture is not read as a statement
const code = (text: string): string => text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')

export const verdict = (text: string): Verdict => {
  const c = code(text)
  if (CONTROL.test(c) || BLOCK.test(c) || c.includes(';')) return 'refused'
  if (ARROW.test(c)) return text.length > ARROW_LIMIT ? 'refused' : 'arrow'
  return text.length > CALL_LIMIT ? 'refused' : 'call'
}

const walk = (dir: string): Array<string> => {
  const out: Array<string> = []
  for (const name of readdirSync(dir)) {
    const at = join(dir, name)
    if (statSync(at).isDirectory()) {
      if (name === 'node_modules' || name === 'host' || name === 'tmp') continue
      if (existsSync(join(at, 'deck.tree'))) continue // a fixture project, term test does not walk it
      out.push(...walk(at))
    } else if (name.endsWith('.tree')) out.push(at)
  }
  return out
}

type Open = { name: string; bodies: Array<string>; declared: { word: string; why: string } | null }

export const measure = ({ term, file }: { term: string; file: string }): Row => {
  const lines = readFileSync(file, 'utf8').split('\n')
  const binds: Array<Open> = []
  let tests = 0
  let bind: Open | null = null
  let bindIndent = -1
  let body: string | null = null
  let bodyIndent = -1
  let title: string | null = null
  let facts = 0
  let declared: { word: string; why: string } | null = null
  const close = (): void => {
    if (body !== null && bind) bind.bodies.push(body)
    body = null
  }
  for (let at = 0; at < lines.length; at++) {
    const raw = lines[at] as string
    const line = raw.trimStart()
    const indent = raw.length - line.length
    if (indent === 0 && /^(test|hold|rule) /.test(line)) {
      tests++
      title = line.match(/^test <(.*)>\s*$/)?.[1] ?? null
    } else if (indent === 0 && line) title = null
    if (title && title.length > 12 && indent > 0 && /^want hold/.test(line) && line.includes(`<${title}>`)) facts++
    if (bind && line && indent <= bindIndent) {
      close()
      binds.push(bind)
      bind = null
    }
    const said = line.match(/^# host (\w+): (.+)$/)
    if (said) {
      declared = { word: said[1] as string, why: said[2] as string }
      continue
    }
    if (indent === 0 && /^bind [\w-]+\s*$/.test(line)) {
      bind = { name: line.slice(5).trim(), bodies: [], declared }
      bindIndent = indent
      declared = null
      continue
    }
    if (line && !line.startsWith('#')) declared = null
    if (!bind) continue
    const head = line.match(/^case ([\w-]+)(?:,\s*(?:text\s*)?<(.*)>\s*)?$/)
    if (head) {
      close()
      body = head[2] ?? ''
      bodyIndent = indent
      continue
    }
    if (body !== null && indent > bodyIndent) {
      const inner = line.replace(/^text\s*/, '').match(/^<<?(.*?)>?>\s*$/s)
      body += inner ? inner[1] : line
    }
  }
  if (bind) {
    close()
    binds.push(bind)
  }
  const whole = lines.join('\n')
  const rel = relative(term, file)
  const row: Row = {
    file: rel,
    tests,
    binds: [],
    host: 0,
    call: 0,
    arrow: 0,
    refused: 0,
    refusedChars: 0,
    declared: 0,
    facts,
    runs: RUNS_TEXT.test(whole),
    whole: whole.length,
  }
  for (const b of binds) {
    const bodies = b.bodies.length ? b.bodies : ['']
    let worst: Verdict = 'call'
    let size = 0
    for (const t of bodies) {
      size += t.length
      const v = verdict(t)
      if (v === 'refused' || (v === 'arrow' && worst === 'call')) worst = v
    }
    const allowed =
      b.declared !== null &&
      WORDS.includes(b.declared.word) &&
      (b.declared.word === 'subject' ? SUBJECT.includes(rel) : size <= DECLARED_LIMIT)
    const said: Verdict = worst === 'refused' && allowed ? 'declared' : worst
    row.binds.push({ name: b.name, size, verdict: said, why: b.declared?.why ?? '', text: bodies.join(' || ').slice(0, 200) })
    row.host += size
    row[said]++
    if (said === 'refused') row.refusedChars += size
  }
  return row
}

const isSupport = (r: Row): boolean => r.file.startsWith('test/support/')
const isSuite = (r: Row): boolean => !isSupport(r) && r.tests > 0
const held = (r: Row): boolean => isSuite(r) && (r.refused > 0 || r.facts > 0 || r.runs)

// every suite under the Term root's test/ and each package's test/, the rows with anything to say, and their totals
export const scan = ({ term, prefixes }: { term: string; prefixes: ReadonlyArray<string> }): { rows: Array<Row>; total: Total } => {
  const roots = [join(term, 'test')]
  if (existsSync(join(term, 'deck'))) {
    for (const d of readdirSync(join(term, 'deck'))) if (existsSync(join(term, 'deck', d, 'test'))) roots.push(join(term, 'deck', d, 'test'))
  }
  const rows: Array<Row> = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const file of walk(root)) {
      const rel = relative(term, file)
      if (prefixes.length && !prefixes.some(p => rel.startsWith(p))) continue
      const row = measure({ term, file })
      if (row.binds.length || row.facts || row.runs) rows.push(row)
    }
  }
  const sum = (list: Array<Row>, field: 'host' | 'call' | 'arrow' | 'refused' | 'refusedChars' | 'declared' | 'facts'): number =>
    list.reduce((n, r) => n + r[field], 0)
  const suites = rows.filter(isSuite)
  const support = rows.filter(isSupport)
  const total: Total = {
    suites: suites.length,
    host: sum(suites, 'host'),
    call: sum(suites, 'call'),
    arrow: sum(suites, 'arrow'),
    refused: sum(suites, 'refused'),
    refusedChars: sum(suites, 'refusedChars'),
    declared: sum(suites, 'declared'),
    facts: sum(suites, 'facts'),
    heldFiles: suites.filter(held).length,
    supportHost: sum(support, 'host'),
    supportRefused: sum(support, 'refused'),
  }
  return { rows, total }
}

const main = (): void => {
  const args = process.argv.slice(2)
  const has = (flag: string): boolean => args.includes(flag)
  const listAt = args.indexOf('--list')
  const rootAt = args.indexOf('--root')
  const term = rootAt >= 0 ? resolve(args[rootAt + 1] as string) : TERM
  const prefixes = args.filter((a, at) => !a.startsWith('--') && (listAt < 0 || at !== listAt + 1) && (rootAt < 0 || at !== rootAt + 1))
  const { rows, total } = scan({ term, prefixes })
  const suites = rows.filter(isSuite)

  if (listAt >= 0) {
    const row = measure({ term, file: resolve(term, args[listAt + 1] as string) })
    for (const b of row.binds) console.log(`${b.verdict} ${b.size} ${b.name}: ${b.text}`)
    console.log(`facts ${row.facts}, runs text ${row.runs}`)
  } else if (has('--items')) {
    const found = JSON.parse(readFileSync(BATCHES(), 'utf8')) as { batch: Array<{ id: string; files: Array<string | { path: string }> }> }
    const stemOf = (f: string): string => f.replace(/\.(ts|tree)$/, '')
    const batchOf = new Map<string, string>()
    for (const b of found.batch) {
      for (const f of b.files) batchOf.set(stemOf(typeof f === 'string' ? f : f.path).replace(/^deck\/term\/deck\/term\//, ''), b.id)
    }
    for (const r of suites.filter(held).sort((a, b) => b.refusedChars - a.refusedChars)) {
      console.log(
        `${batchOf.get(stemOf(r.file)) ?? 'no-batch'} ${r.file} refused ${r.refused} chars ${r.refusedChars} facts ${r.facts} tests ${r.tests} arrow ${r.arrow} share ${Math.round((100 * r.host) / r.whole)}%`,
      )
    }
    console.log(JSON.stringify(total))
  } else {
    console.log('refused-chars refused arrow call declared facts share tests file')
    for (const r of [...rows].sort((a, b) => b.refusedChars - a.refusedChars || b.arrow - a.arrow)) {
      if (!r.refused && !r.arrow && !r.facts && !r.runs && !r.declared) continue
      console.log([r.refusedChars, r.refused, r.arrow, r.call, r.declared, r.facts, `${Math.round((100 * r.host) / r.whole)}%`, r.tests, r.file].join(' '))
    }
    console.log(JSON.stringify(total))
  }

  if (has('--fail')) {
    const bad = suites.filter(held)
    if (bad.length) {
      console.error(`HOST TEXT: ${bad.length} suite files hold logic in a bind (decision 113): ${bad.map(r => r.file).join(' ')}`)
      process.exitCode = 1
    } else console.log('HOST TEXT: clean')
  }
  if ((has('--ratchet') || has('--commit')) && rootAt < 0) {
    const was = existsSync(BASELINE()) ? (JSON.parse(readFileSync(BASELINE(), 'utf8')) as Record<string, number>) : null
    const now: Record<string, number> = { refused: total.refused, arrow: total.arrow, heldFiles: total.heldFiles, facts: total.facts }
    const rose = was ? Object.keys(now).filter(k => (now[k] as number) > (was[k] as number)) : []
    if (rose.length && was) {
      console.error(`HOST TEXT: rose past the baseline: ${rose.map(k => `${k} ${was[k]} to ${now[k]}`).join(', ')}`)
      process.exitCode = 1
    } else if (has('--commit')) {
      writeFileSync(BASELINE(), `${JSON.stringify(now, null, 1)}\n`)
      console.log(`baseline written: ${JSON.stringify(now)}`)
    } else console.log(`HOST TEXT ratchet holds: ${JSON.stringify(now)} of ${JSON.stringify(was)}`)
  }
}

// run as a command, never on import (floor.ts imports scan)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
