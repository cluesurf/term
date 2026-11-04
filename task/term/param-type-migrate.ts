// Type the parameters the strict census names (`pnpm term:param-type-migrate`), decisions-2026-10.md, D10.
//
// Under TERM_INFER_STRICT the checker refuses `"<name>" of "<task>" is never given a type` for a parameter no call and
// no use gives a type (deck/make/code/check/infer.ts, check/strict.ts). This writes the type the person names, on the
// parameter's own `take` line: `take class` becomes `take class, like text`. A parameter is found by what the checker
// reported, never by its spelling: the diagnostic's span is the task or view it belongs to, and the `take` is the child
// of that definition, read from the compiler's own parse (parser/tree.ts), so a `take class` of a task the checker did
// not refuse is left alone, and so is a `take` that already carries a `like` or a `fall`.
//
// Each changed file is PROVEN before it is written, three ways:
//   1. it builds before, with the strict refusal off, and again after
//   2. its own checked statements, spans and `type` fields aside, are equal before and after (a `like` adds the type
//      the parameter had as a free variable, and nothing else may differ)
//   3. with the refusal on, the file's refusals after are exactly the ones before less those this wrote
// A file that fails any of the three is left as it is and named.
//
//   pnpm term:param-type-migrate --name=class --type=text          report what would change, every package
//   pnpm term:param-type-migrate --name=class --type=text --commit write each file whose proof holds
//   --only=face,base                                               those packages (default: every package and zone)
//   --explain                                                      where an unproven file's two programs part
//
// Run from the Term root, where the `@term/*` paths resolve (the alias starts there).

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { setInferStrict } from '@term/make/code/check/strict'
import { buildable, findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { carriesTests, readable } from '@term/call/code/test-preprocess'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { parse, renderHead } from '@term/make/code/parser/tree'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { TERM_ROOT, parentPaths } from './root'

const TERM = TERM_ROOT
const REPO = TERM_ROOT
const commit = process.argv.includes('--commit')
const explain = process.argv.includes('--explain')
const argument = (key: string): string | undefined => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
const name = argument('name')
const type = argument('type')
const only = argument('only')?.split(',')

if (!name || !type) {
  console.error('param-type-migrate: --name=<parameter> and --type=<type> are both required')
  process.exit(2)
}

const NEVER = /^"([^"]+)" of "([^"]+)" is never given a type/

type Built = ReturnType<typeof compile>
type Build = (text: string) => { result: Built; place?: (d: Diagnostic) => { diagnostic: Diagnostic } }

// the refusals of a build, as `<task>:<parameter>` at the line of the definition they belong to
function refusals(built: ReturnType<Build>, file: string): string[] {
  if (built.result.ok) {
    return []
  }

  return built.result.diagnostics.flatMap(diagnostic => {
    const match = NEVER.exec(diagnostic.message.replace(/\s+/g, ' '))

    if (!match || (diagnostic.file ?? file) !== file) {
      return []
    }

    const span = built.place ? built.place(diagnostic).diagnostic.span : diagnostic.span

    return [`${span.start.line}:${match[1]}`]
  })
}

// the checker's own statements for this file, spans and types aside
function ownStatements(program: unknown[], file: string): string {
  const own = program.filter(statement => ((statement as { span?: Span }).span?.file ?? file) === file)

  return JSON.stringify(own, (key, value: unknown) => (key === 'span' || key === 'origin' || key === 'markers' || key === 'type' ? undefined : value))
}

// `take <name>` lines with no `like`, as the parser reads them: for each top-level definition on a line in `lines`, the
// line of its own `take <name>` child
function takeLines(text: string, lines: Set<number>): Map<number, number> {
  const parsed = parse({ file: 'scan.tree', text })
  const found = new Map<number, number>()

  if (!parsed.ok) {
    return found
  }

  const head = (group: GroupNode): string | undefined => (group.nodes[0]?.kind === 'name' ? renderHead(group.nodes[0]) : undefined)

  for (const top of parsed.tree.nodes) {
    const at = top.kind === 'group' ? spanOfNode(top)?.start.line : undefined

    if (top.kind !== 'group' || at === undefined || !lines.has(at)) {
      continue
    }

    for (const child of top.nodes.slice(1)) {
      if (child.kind !== 'group' || head(child) !== 'take') {
        continue
      }

      const target = child.nodes[1]

      // `take <name>` alone: one word after the head, nothing under it
      if (child.nodes.length === 2 && target?.kind === 'group' && head(target) === name && target.nodes.length === 1) {
        const line = spanOfNode(child)?.start.line

        if (line !== undefined) {
          found.set(at, line)
        }
      }
    }
  }

  return found
}

let texts = 0
let changed = 0
let written = 0
const unproven: string[] = []
const broken: string[] = []

const roots = [
  ...readdirSync(path.join(TERM, 'deck'))
    .map(one => path.join(TERM, 'deck', one))
    .filter(dir => existsSync(path.join(dir, 'deck.tree'))),
  ...parentPaths('deck/zone'),
].filter(dir => !only || only.includes(path.basename(dir)))

for (const root of roots) {
  const resolve = projectResolver(root)
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)

  for (const file of findTreeFiles(root, [], 'node')) {
    const source = readFileSync(file, 'utf8')
    const unit = buildable(file, source, roleOf(file))

    if ('faults' in unit || roleOf(file) === 'mill' || !new RegExp(`^\\s+take ${name}\\s*$`, 'm').test(source)) {
      continue
    }

    const build: Build = text => {
      const built = buildable(file, text, roleOf(file))
      const body = 'faults' in built ? text : built.text
      const compiled = carriesTests(body) ? readable(body) : undefined

      return { result: compile({ file, text: compiled?.text ?? body }, { resolve, deckOf, roleOf, leanOf, env: 'node' }), place: compiled?.place }
    }
    const where = path.relative(REPO, file)

    texts++
    setInferStrict(true)

    const strictBefore = build(source)
    const refused = refusals(strictBefore, file)
    const wanted = new Set(refused.filter(one => one.endsWith(`:${name}`)).map(one => Number(one.split(':')[0])))

    if (wanted.size === 0) {
      continue
    }

    const targets = takeLines(source, wanted)
    const lines = source.split('\n')
    const done: number[] = []

    for (const line of [...targets.values()]) {
      if (lines[line]!.trim() === `take ${name}`) {
        lines[line] = `${lines[line]!.replace(/\s+$/, '')}, like ${type}`
        done.push(line)
      }
    }

    if (done.length === 0) {
      continue
    }

    changed++

    const next = lines.join('\n')
    const written_ = new Set([...targets.entries()].filter(([, line]) => done.includes(line)).map(([definition]) => definition))
    const strictAfter = build(next)
    const expected = refused.filter(one => !(one.endsWith(`:${name}`) && written_.has(Number(one.split(':')[0])))).sort()
    const actual = refusals(strictAfter, file).sort()

    setInferStrict(false)

    const plainBefore = build(source)
    const plainAfter = build(next)

    if (!plainBefore.result.ok) {
      broken.push(`${where} (${plainBefore.result.diagnostics[0]?.message ?? 'does not build'})`)
      continue
    }

    if (!plainAfter.result.ok) {
      unproven.push(`${where} (does not build after: ${plainAfter.result.diagnostics[0]?.message ?? ''})`)
      continue
    }

    const was = ownStatements(plainBefore.result.program, file)
    const now = ownStatements(plainAfter.result.program, file)

    if (was !== now) {
      const at = [...was].findIndex((char, i) => char !== now[i])

      unproven.push(
        `${where} (${explain ? `the program differs:\n    was ${was.slice(Math.max(0, at - 120), at + 120)}\n    now ${now.slice(Math.max(0, at - 120), at + 120)}` : 'the program differs'})`,
      )
      continue
    }

    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      unproven.push(`${where} (the refusals after are not the ones before less those written: ${expected.length} expected, ${actual.length} found)`)
      continue
    }

    written += done.length
    console.log(`${commit ? 'wrote ' : 'would '}${where}: ${done.length} parameter${done.length === 1 ? '' : 's'}`)

    if (commit) {
      writeFileSync(file, next)
    }
  }
}

console.log(`\nparam-type-migrate ${name} as ${type}: ${texts} files read, ${changed} with a parameter to type, ${written} parameters${commit ? ' written' : ' (report only: --commit writes)'}`)

if (unproven.length > 0) {
  console.log(`\n${unproven.length} not proven, left as they are:\n  ${unproven.join('\n  ')}`)
}

if (broken.length > 0) {
  console.log(`\n${broken.length} do not build before any change, left as they are:\n  ${broken.slice(0, 40).join('\n  ')}${broken.length > 40 ? `\n  and ${broken.length - 40} more` : ''}`)
}

process.exit(unproven.length > 0 ? 1 : 0)
