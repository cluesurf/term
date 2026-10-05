import fs from 'fs/promises'
import path from 'path'
import { analyze } from '@term/make/code/analyze'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Finding, TextEdit } from '@term/make/code/lint/rule'
import { collectTreeFiles } from '@term/call/code/files'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { manifestName } from '@term/call/code/manifest-name'
import { projectResolver } from '@term/call/code/make'
import { manifestSpellings } from '@cluesurf/deck.tree'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { GroupNode, Node } from '@term/make/code/parser/tree'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import type { Resolver } from '@term/make/code/compile/load'
import { closeRun, count, openRun, report, reportProblems } from '@term/call/code/output'

// turn a lint finding into the compiler's Diagnostic shape so it renders identically. The stable rule code (`L003`)
// is printed as written (`rule`), and the rule name is the heading.
function toDiagnostic(finding: Finding, file: string): Diagnostic {
  return {
    code: parseInt(finding.code.replace(/\D/g, ''), 10),
    rule: finding.code,
    name: finding.rule,
    message: finding.message,
    file,
    span: finding.span,
    markers: [{ span: finding.span }],
    hint: finding.fix ? 'fixable: run `term lint --fix`' : undefined,
    severity: finding.severity,
  }
}

// apply text edits to source. Edits are applied right-to-left so earlier offsets stay valid; overlapping edits are
// dropped (the first one in source order wins).
function applyEdits(text: string, edits: TextEdit[]): string {
  const lineStarts = [0]

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1)
    }
  }

  const offset = (pos: { line: number; column: number }) =>
    (lineStarts[pos.line] ?? text.length) + pos.column

  const ranges = edits
    .map(e => ({
      start: offset(e.span.start),
      end: offset(e.span.end),
      text: e.text,
    }))
    .sort((a, b) => b.start - a.start)

  let result = text
  let lastStart = Infinity

  for (const range of ranges) {
    if (range.end > lastStart) {
      continue
    } // overlaps an already-applied edit; skip

    result =
      result.slice(0, range.start) +
      range.text +
      result.slice(range.end)
    lastStart = range.start
  }

  return result
}

// ---- findings that need the FILESYSTEM, so they live here rather than among the pure AST rules ----
//
// note/term/plan/manifest-mark-and-code-root.md. Three, each a warning:
//
//   L050 manifest-code-version  a manifest's `code <version>` (or a link's `code <range>`): the old spelling of
//                               `mark`. `--fix` rewrites the word
//   L051 manifest-bear          a manifest's `bear ./dir`: the old spelling of the code root, `code ./dir`.
//                               `--fix` removes `bear ./code` (the default) and rewrites any other to `code`
//   L052 ambiguous-load         a package path that names a file in the package's code root AND one in its package
//                               root. The code root wins; this names both, so a shadowed folder is never silent.
//                               `base <dir>` under the load picks the package root and silences it
//   L055 manifest-inert         a manifest field no tool reads (`test`, `book` and eleven more). See below

const MANIFEST_CODES = { 'manifest-code-version': 'L050', 'manifest-bear': 'L051' } as const

// L055 manifest-inert: a manifest field the grammar accepts and the writer keeps, which no tool reads. `test ./test`
// looked like it chose where `term test` looks, and it chooses nothing: it finds tests in `code/` and `test/` whatever
// the line says (guides: packages/manifest, 2026-10-04). A nested `deck ./path` is the same. No `--fix`, because the
// line may record an intent, and deleting it is the author's call
const INERT_FIELDS = new Set(['test', 'book', 'tool', 'call', 'task', 'hook', 'hide', 'view', 'sort', 'term', 'text', 'cite', 'deck'])

export function inertManifestFields(text: string, file: string): Finding[] {
  if (manifestName(text, file) === undefined) {
    return []
  }

  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return []
  }

  const headOf = (node: Node | undefined): string | undefined => {
    const first = node?.kind === 'group' ? node.nodes[0] : undefined

    return first?.kind === 'name' ? renderHead(first) : undefined
  }

  const out: Finding[] = []

  for (const root of parsed.tree.nodes) {
    if (headOf(root) !== 'deck' || root.kind !== 'group') {
      continue
    }

    // the deck's name, then its fields
    for (const field of root.nodes.slice(2)) {
      const word = headOf(field)
      const name = field.kind === 'group' ? field.nodes[0] : undefined
      const at = name ? spanOfNode(name) : undefined

      if (word === undefined || !INERT_FIELDS.has(word) || !at) {
        continue
      }

      out.push({
        rule: 'manifest-inert',
        code: 'L055',
        message: `\`${word}\` in a manifest is read by nothing. It parses and is kept, and no tool acts on it`,
        severity: 'warning',
        span: { start: at.start, end: { line: at.start.line, column: at.start.column + word.length } },
      })
    }
  }

  return out
}

export function manifestFindings(text: string, file: string): Finding[] {
  if (manifestName(text, file) === undefined) {
    return []
  }

  return manifestSpellings({ text, file }).map(found => ({
    rule: found.rule,
    code: MANIFEST_CODES[found.rule],
    message: found.message,
    severity: 'warning',
    span: { start: { line: found.line, column: found.column }, end: { line: found.line, column: found.end } },
    fix: found.wholeLine
      ? { span: { start: { line: found.line, column: 0 }, end: { line: found.line + 1, column: 0 } }, text: '' }
      : {
          span: { start: { line: found.line, column: found.column }, end: { line: found.line, column: found.end } },
          text: found.text,
        },
  }))
}

// every top-level `load` path with its span and its `base`, read with the one parser
function loadPaths(text: string, file: string): { path: string; base?: string; span: Finding['span'] }[] {
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return []
  }

  const headOf = (node: Node | undefined): string | undefined => {
    const first = node?.kind === 'group' ? node.nodes[0] : undefined

    return first?.kind === 'name' ? renderHead(first) : undefined
  }

  const out: { path: string; base?: string; span: Finding['span'] }[] = []

  for (const group of parsed.tree.nodes) {
    if (headOf(group) !== 'load') {
      continue
    }

    const target = group.nodes[1]
    const path = headOf(target)
    const name = target?.kind === 'group' ? target.nodes[0] : undefined
    const start = name ? spanOfNode(name) : undefined

    if (!path || !start) {
      continue
    }

    const baseGroup = group.nodes
      .slice(2)
      .find((n): n is GroupNode => n.kind === 'group' && headOf(n) === 'base')

    out.push({
      path,
      base: baseGroup ? headOf(baseGroup.nodes[1]) : undefined,
      span: { start: start.start, end: { line: start.start.line, column: start.start.column + path.length } },
    })
  }

  return out
}

export function ambiguousLoads(text: string, file: string, resolve: Resolver): Finding[] {
  const out: Finding[] = []

  for (const load of loadPaths(text, file)) {
    if (load.base !== undefined || load.path.startsWith('.')) {
      continue
    }

    let found

    try {
      found = resolve(load.path, file)
    } catch {
      continue
    }

    if (found?.shadowed) {
      out.push({
        rule: 'ambiguous-load',
        code: 'L052',
        severity: 'warning',
        span: load.span,
        message: `\`${load.path}\` names two files: ${found.file} in the code root, which it resolves to, and ${found.shadowed} in the package root, which it shadows. Write \`base ${load.path.replace(/^@[^/]+\/[^/]+\/|^@\//, '').split('/')[0]}\` under the load to mean the second`,
      })
    }
  }

  return out
}

// `term lint` -- lint `.tree` files. `--fix` applies autofixes in place; otherwise findings are reported. Exits
// non-zero when any error-severity finding remains (so it gates CI).
export async function callLint(input: {
  root: string
  paths: string[]
  fix?: boolean
}): Promise<void> {
  const files = await collectTreeFiles(input.paths, input.root)

  openRun({ verb: 'lint', root: input.root, counts: [count(files.length, 'files', 'file')], facts: input.fix ? ['--fix'] : [] })

  if (files.length === 0) {
    report({ glyph: 'failed', kind: 'problem', subject: 'There is no .tree file to lint', message: input.paths.length ? [`Looked in ${input.paths.join(', ')}.`] : [] })
    closeRun({ verdict: 'Nothing to lint' })

    return
  }

  // the role and `mark lean` each file's role rule gives it, as the build reads them. Without these a lean file is
  // milled as longhand and linted as a program the build never compiles.
  const roleOf = projectRoleOf(input.root)
  const leanOf = projectLeanOf(input.root)
  const readersOf = (file: string) => ({
    role: roleOf(file),
    lean: leanOf(file),
  })

  let totalFindings = 0
  let totalErrors = 0
  let totalFixed = 0
  // every finding of every file, drawn together at the end so they sort by path, line and column (section 12)
  const found: { diagnostic: Diagnostic; text: string }[] = []

  // the build's own resolver, so an ambiguity is reported exactly where the build would resolve one
  const resolve = projectResolver(input.root)
  const fileFindings = (text: string, file: string): Finding[] => [
    ...manifestFindings(text, file),
    ...inertManifestFields(text, file),
    ...ambiguousLoads(text, file, resolve),
  ]

  for (const file of files) {
    const text = await fs.readFile(file, 'utf-8')
    const relative = path.relative(input.root, file)
    const readers = readersOf(path.resolve(input.root, file))
    const absolute = path.resolve(input.root, file)
    const findings = [...analyze({ file: relative, text }, readers).lint(), ...fileFindings(text, absolute)]

    if (findings.length === 0) {
      continue
    }

    if (input.fix) {
      const fixes = findings
        .map(f => f.fix)
        .filter((f): f is TextEdit => Boolean(f))

      const fixedText =
        fixes.length > 0 ? applyEdits(text, fixes) : text

      if (fixes.length > 0) {
        await fs.writeFile(file, fixedText, 'utf-8')
        totalFixed += fixes.length
      }

      // re-lint to report what the fixes did not resolve
      const remaining = [
        ...analyze(
          {
            file: relative,
            text: fixedText,
          },
          readers,
        ).lint(),
        ...fileFindings(fixedText, absolute),
      ]

      for (const finding of remaining) {
        if (finding.severity === 'error') {
          totalErrors++
        }

        totalFindings++
        found.push({ diagnostic: toDiagnostic(finding, relative), text: fixedText })
      }
    } else {
      for (const finding of findings) {
        if (finding.severity === 'error') {
          totalErrors++
        }

        totalFindings++
        found.push({ diagnostic: toDiagnostic(finding, relative), text })
      }
    }
  }

  reportProblems(found, input.root)

  if (totalFixed > 0) {
    report({ glyph: 'changed', kind: 'change', verb: 'fix', subject: 'findings fixed in place', counts: [count(totalFixed, 'fixes', 'fix')] })
  }

  const warnings = totalFindings - totalErrors
  const counts = [...(totalErrors ? [count(totalErrors, 'errors', 'error')] : []), ...(warnings ? [count(warnings, 'warnings', 'warning')] : [])]

  // the closing glyph is the worst finding's: ✗ for an error (exit 1), ▲ for warnings alone (exit 0, 1 under --strict)
  closeRun({
    verdict: totalFindings === 0 ? 'No lint findings' : `${totalFindings} finding${totalFindings === 1 ? '' : 's'}`,
    counts,
    next: found.some(one => one.diagnostic.hint) && !input.fix ? 'term lint --fix' : undefined,
  })
}
