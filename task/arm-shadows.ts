// The arm-shadow warnings of the named ports, narrowed to the ones that can bite: a `case` arm that binds a field named
// like a variable in scope AND READS that name in its body. A shadow the arm never reads hides nothing a reader could
// mean (term-self-host-001-0202: simplifying.tree held 300+ warnings and one real hit). Run from deck/term/deck/term:
//   npx tsx task/arm-shadows.ts deck/make/code/check/extend.tree ...
// (tmp/probe-arm-shadows.ts, run by the repository's tmp/run-arm-shadows.sh, calls this.) test/check/arm-shadow-reads.ts
// holds the read rule.
// Output per file: `== file`, then one line per arm that reads a hidden name, then `summary: ...`. A last `total:` line.
// Exit 0 when no arm reads a hidden name, 1 when one does, 2 when a file would not compile.
//
// WHY TEXT: the checker's warning carries the `sift` line and the case label, not the arm, and the program `compile`
// returns is the lowered one (inlined, renamed locals), so the arm is read back from the source by indentation. The scan
// OVER-approximates a read (a word that is not a head, a path segment, a callee or a binder), so it never misses one.
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

type Warning = { message: string; file?: string; span?: { start: { line: number } } }

const SHADOW = /^"case ([^"]+)" binds its field "([^"]+)" as "([^"]+)", which hides/

// words after which the next word is a binder, a type, a name or a label, never a read of a variable
const NOT_A_READ_AFTER = new Set(['link', 'like', 'make', 'call', 'view', 'name', 'case', 'find', 'bind', 'take', 'save', 'host', 'form', 'task', 'load', 'hook', 'walk', 'seat', 'head', 'beam', 'tick', 'mark', 'note', 'role', 'tell'])

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

// a line with its comment gone and each text literal reduced to its `{interpolations}`
function codeOf(line: string): string {
  const trimmed = line.trimStart()

  if (trimmed.startsWith('#')) {
    return ''
  }

  const stripped = line.replace(/<<.*?>>/g, ' ').replace(/<[^<>]*>/g, literal => (literal.match(/\{[^{}]*\}/g) ?? []).join(' '))

  return stripped
}

// the lines of the arm `case <label>` under the match at `matchLine` (1-based): [first, last], 1-based, or undefined
function armOf(lines: string[], matchLine: number, label: string): [number, number] | undefined {
  const head = lines[matchLine - 1]

  if (head === undefined) {
    return undefined
  }

  const base = indentOf(head)

  for (let i = matchLine; i < lines.length; i++) {
    const line = lines[i]!

    if (line.trim() === '') {
      continue
    }

    const indent = indentOf(line)

    if (indent <= base) {
      return undefined
    }

    if (indent === base + 2 && line.trim().split(/[\s,]/)[0] === 'case' && line.trim().split(/[\s,]+/)[1] === label) {
      let last = i + 1

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!

        if (next.trim() === '') {
          continue
        }

        if (indentOf(next) <= indent) {
          break
        }

        last = j + 1
      }

      return [i + 1, last]
    }
  }

  return undefined
}

// the 1-based lines in [first, last] that read the variable `name`
export function readsIn(lines: string[], first: number, last: number, name: string): number[] {
  const found: number[] = []
  const word = /[A-Za-z_][A-Za-z0-9_-]*/g

  for (let n = first; n <= last; n++) {
    const raw = lines[n - 1]!
    const code = codeOf(raw)

    if (code.trim() === '' || /^\s*link\b/.test(code)) {
      continue
    }

    const lead = indentOf(raw)
    const nextIndent = (() => {
      for (let k = n; k < lines.length; k++) {
        if (lines[k]!.trim() !== '') {
          return indentOf(lines[k]!)
        }
      }

      return -1
    })()

    let match: RegExpExecArray | null
    let previousWord = ''
    let previousEnd = 0

    word.lastIndex = 0

    while ((match = word.exec(code)) !== null) {
      const token = match[0]
      const start = match.index
      const end = start + token.length
      const before = code[start - 1] ?? ''
      const after = code[end] ?? ''
      const isFirst = code.slice(0, start).trim() === ''
      // the word before is a head of this one only when nothing but spaces stands between them (`name span`): after
      // `one/name, name` or `f(name)` the earlier word is a member or an argument, and this one is a read
      // (term-compiler-0042: `is-equal(one/name, name)` took the member `name` for a `name` head and skipped the read)
      const prior = /^ +$/.test(code.slice(previousEnd, start)) ? previousWord : ''

      previousWord = token
      previousEnd = end

      if (token !== name) {
        continue
      }

      // a path segment (`x/span`) or a keyed member is not the variable
      if (before === '/') {
        continue
      }

      // a call of a task that bears the name
      if (after === '(') {
        continue
      }

      // a binder, a type, a label: `bind span, ...`, `like span`, `name span`
      // (`read` is the one head that reads, and it is not in the set)
      if (NOT_A_READ_AFTER.has(prior)) {
        continue
      }

      // the head of a line that carries something after it, or children under it, names an argument or a keyword
      if (isFirst && code.trim() !== token) {
        const rest = code.slice(end).trimStart()

        if (!rest.startsWith(',') && !rest.startsWith('/')) {
          continue
        }
      }

      if (isFirst && code.trim() === token && nextIndent > lead) {
        continue
      }

      found.push(n)

      break
    }
  }

  return found
}

type Count = { reads: number; same: number; quiet: number; total: number }

// The enclosing `case`/`sift` pairs of a line, innermost first: each arm's label, its subject text and its line.
function enclosing(lines: string[], line: number): { label: string; subject: string; caseLine: number }[] {
  const chain: { label: string; subject: string; caseLine: number }[] = []
  let indent = indentOf(lines[line - 1]!)

  for (let i = line - 2; i >= 0 && indent > 0; i--) {
    const text = lines[i]!

    if (text.trim() === '' || text.trimStart().startsWith('#') || indentOf(text) >= indent) {
      continue
    }

    indent = indentOf(text)

    const arm = /^\s*case\s+([^\s,]+)/.exec(text)

    if (arm) {
      // its subject is the nearest line above it, one level out, that is a `sift` or `fork case`
      for (let j = i - 1; j >= 0; j--) {
        const parent = lines[j]!

        if (parent.trim() === '' || indentOf(parent) >= indent) {
          continue
        }

        const subject = /^\s*(?:sift\s+|fork case,\s*)(\S.*?)\s*$/.exec(parent)

        chain.push({ label: arm[1]!, subject: subject ? subject[1]! : '', caseLine: i + 1 })

        break
      }
    }
  }

  return chain
}

// An inner `case X` under an outer `case X` over the SAME value (the same variable, or a local made by
// `save inner, shallow-copy(outer)` / `save inner, outer` inside the outer arm) binds the very fields the outer arm
// bound, so reading a hidden name there reads the same value: not the trap (the `!<boolean>` fold read an OPERAND's
// span, a different node). Anything else stays reported.
function sameNode(lines: string[], line: number, label: string): boolean {
  const inner = /^\s*(?:sift\s+|fork case,\s*)(\S.*?)\s*$/.exec(lines[line - 1] ?? '')

  if (!inner) {
    return false
  }

  const innerSubject = inner[1]!

  return enclosing(lines, line).some(outer => {
    if (outer.label !== label || outer.subject === '') {
      return false
    }

    if (outer.subject === innerSubject) {
      return true
    }

    const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const copied = new RegExp(`^\\s*save\\s+${escaped(innerSubject)},\\s*(?:[a-z-]*copy[a-z-]*\\()?${escaped(outer.subject)}\\)?\\s*$`)

    for (let n = outer.caseLine; n < line - 1; n++) {
      if (copied.test(lines[n]!)) {
        return true
      }
    }

    return false
  })
}

export function scan(file: string): { out: string[]; count: Count; failed: boolean } {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const out: string[] = []
  const count: Count = { reads: 0, same: 0, quiet: 0, total: 0 }
  const built = compile({ file, text }, { resolve: projectResolver(resolvePath('deck/make'), 'node'), library: true, leanOf: () => true } as never)

  if (!built.ok) {
    out.push(`  FAILED ${built.diagnostics.map(d => d.message.split('\n')[0]).join(' | ')}`)

    return { out, count, failed: true }
  }

  const warnings = (built as { warnings?: Warning[] }).warnings ?? []
  const seen = new Set<string>()
  const here = resolvePath(file)
  const elsewhere = new Map<string, number>()

  if (process.env.ARM_SHADOWS_DEBUG) {
    console.log('  debug keys', Object.keys(warnings[0] ?? {}), [...new Set(warnings.map(w => String(w.file)))].slice(0, 8))
  }

  for (const w of warnings) {
    const shadow = SHADOW.exec(w.message.split('\n')[0] ?? '')

    if (!shadow || !w.span) {
      continue
    }

    // the build's warnings name the file each span is in: a port's imports ride along, and their lines are theirs
    if (w.file !== undefined && resolvePath(w.file) !== here) {
      elsewhere.set(w.file, (elsewhere.get(w.file) ?? 0) + 1)

      continue
    }

    const [, label, field, local] = shadow as unknown as [string, string, string, string]
    const line = w.span.start.line + 1
    const key = `${line}|${label}|${local}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    count.total++

    const arm = armOf(lines, line, label)
    const reads = arm ? readsIn(lines, arm[0], arm[1], local) : []

    if (!arm) {
      // the arm could not be found by indentation: report it, never drop it
      count.reads++
      out.push(`  line ${line}: "case ${label}" binds "${field}" as "${local}", hiding the outer "${local}"; arm not located, check by hand`)
    } else if (reads.length > 0 && sameNode(lines, line, label)) {
      count.same++
    } else if (reads.length > 0) {
      count.reads++
      out.push(`  line ${line}: "case ${label}" binds "${field}" as "${local}", hiding the outer "${local}", and READS it at line${reads.length === 1 ? '' : 's'} ${reads.slice(0, 6).join(', ')}${reads.length > 6 ? ', ...' : ''}`)
    } else {
      count.quiet++
    }
  }

  const imported = [...elsewhere.values()].reduce((a, b) => a + b, 0)

  out.push(`  summary: ${count.reads} read, ${count.same} read of the same node, ${count.quiet} never read, ${count.total} arm shadows${imported ? ` (${imported} more in ${elsewhere.size} imported file${elsewhere.size === 1 ? '' : 's'}, not this port's)` : ''}`)

  return { out, count, failed: false }
}

// prints each file's hits and the total, and answers the exit code: 0 nothing read, 1 a hidden name read, 2 a failure
export function main(files: string[]): number {
  const total: Count = { reads: 0, same: 0, quiet: 0, total: 0 }
  let failures = 0

  for (const file of files) {
    console.log(`== ${file}`)

    const { out, count, failed } = scan(file)

    for (const line of out) {
      console.log(line)
    }

    total.reads += count.reads
    total.same += count.same
    total.quiet += count.quiet
    total.total += count.total
    failures += failed ? 1 : 0
  }

  console.log(`total: ${total.reads} read, ${total.same} read of the same node, ${total.quiet} never read, ${total.total} arm shadows, ${failures} failed to compile, ${files.length} files`)

  return failures > 0 ? 2 : total.reads > 0 ? 1 : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
