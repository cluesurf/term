/**
 * `term hold --lean`: the second checker over a project's claims (note/project/term/proof/lean-export/spec.md).
 *
 * After the gate, every claim of the project (a `rule` with no `show`) is exported with the terms Term's kernel kept,
 * to ONE Lean 4 file under the project's home (`.base/@term/code/lean/hold.lean`), Lean checks it, and the
 * `#print axioms` line of each claim is read back. Per claim: checked, checked resting on axioms, refused by Lean, or
 * declined by the exporter with its reason. Any of the last three fails the gate, and so does a machine with no Lean:
 * the re-check is never passed in silence.
 *
 * The files exported are the ones holding a claim and every file they load, transitively: a relative load by its path,
 * a package load through the project's resolver. The exporter joins them into one program and reads no module binding
 * yet (the spec's "Not on real modules"), so a load nothing resolves (a native one) is dropped and named, and a claim
 * that needed it is declined by the exporter.
 */

import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parse } from '@term/make/code/parser/tree'
import { groupsOf } from '@term/make/code/parser/narrow'
import { headWord } from '@term/make/code/compile/mill-run'
import { millLoadTargets } from '@term/make/code/compile/mill-check'
import { expandTemplates } from '@term/make/code/compile/template'
import {
  exportLean,
  joinSources,
} from '@term/make/code/check/lean-export'
import {
  findLean,
  leanVersion,
  LEAN_INSTALL,
  runLean,
} from '@term/make/code/check/lean-run'
import { projectResolver, resolveTreeFile } from '@term/call/code/make'
import { withNativeEnv } from '@term/make/code/compile/native'
import { projectHome } from '@term/call/code/home'
import { count, field, report } from '@term/call/code/output'

export type HoldLeanClaim = {
  name: string
  // the file that states it, relative to the project
  file: string
  verdict: 'checked' | 'axioms' | 'refused' | 'declined'
  axioms: string[]
  // Lean's first error line for a refused claim, the exporter's reason for a declined one
  reason?: string
}

export type HoldLean = {
  // the Lean file written, absolute
  file?: string
  // the Lean binary run, and its version
  lean?: string
  version?: string
  // no Lean at TERM_LEAN or on the PATH
  missing: boolean
  claims: HoldLeanClaim[]
  // loads left out of the joined program, `<file>: <target>`
  dropped: string[]
  // what the exporter's own run of the kernel reported
  diagnostics: string[]
  ok: boolean
}

// what one file says at its top level: its claims (a `rule` with no `show` under it) and what it loads
function readFile(file: string): { claims: string[]; loads: string[] } {
  const text = readFileSync(file, 'utf8')
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return { claims: [], loads: [] }
  }

  const claims: string[] = []

  // a claim a template in the file makes (`fuse`) is the file's claim too: a law of the law library is stated that way
  // (call/code/knit-law.ts), and the exporter expands the file's templates as the build does
  for (const group of groupsOf(expandTemplates(parsed.tree).nodes)) {
    if (headWord(group) !== 'rule') {
      continue
    }

    const name = group.nodes[1]

    if (name?.kind !== 'group') {
      continue
    }

    const shows = [...group.nodes, ...name.nodes].some(
      child => child.kind === 'group' && headWord(child) === 'show',
    )

    const word = headWord(name)

    if (!shows && word) {
      claims.push(word)
    }
  }

  return { claims, loads: millLoadTargets({ file, text }) }
}

export async function holdLean(
  root: string,
  files: string[],
): Promise<HoldLean> {
  const read = new Map(files.map(file => [file, readFile(file)]))
  const resolver = withNativeEnv('node', projectResolver(root))
  const stating = files.filter(
    file => read.get(file)!.claims.length > 0,
  )

  // the files to join: each stating file and what it loads by a relative path, every file after what it loads
  const order: string[] = []
  const seen = new Set<string>()
  const dropped: string[] = []

  const visit = (file: string): void => {
    if (seen.has(file)) {
      return
    }

    seen.add(file)

    const own = read.get(file) ?? readFile(file)
    read.set(file, own)

    for (const target of own.loads) {
      const found = target.startsWith('.')
        ? resolveTreeFile(path.resolve(path.dirname(file), target))
        : target
          ? resolver(target, file)?.file
          : undefined

      if (found) {
        visit(found)
      } else {
        dropped.push(
          `${path.relative(root, file)}: ${target || 'a native load'}`,
        )
      }
    }

    order.push(file)
  }

  stating.forEach(visit)

  // the project's own claims: a package's are exported with it, and not reported as the project's
  const own = new Set(files)
  const stated = order
    .filter(file => own.has(file))
    .flatMap(file =>
      read.get(file)!.claims.map(name => ({
        name,
        file: path.relative(root, file),
      })),
    )

  const lean = findLean()
  const result: HoldLean = {
    missing: lean === undefined,
    claims: [],
    dropped,
    diagnostics: [],
    ok: false,
  }

  if (stated.length === 0) {
    result.ok = lean !== undefined

    return result
  }

  let exported: ReturnType<typeof exportLean>

  try {
    exported = exportLean(
      joinSources(
        order.map(file => ({
          file: path.relative(root, file),
          text: readFileSync(file, 'utf8'),
        })),
      ),
    )
  } catch (cause) {
    const reason = `the exporter stopped: ${cause instanceof Error ? cause.message : String(cause)}`
    result.claims = stated.map(({ name, file }) => ({
      name,
      file,
      verdict: 'declined',
      axioms: [],
      reason,
    }))

    return result
  }

  result.diagnostics = exported.kernel.diagnostics

  const file = projectHome(root, 'lean', 'hold.lean')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, exported.lean)
  result.file = file

  const refused = new Map(
    exported.refused.map(one => [one.name, one.reason]),
  )

  const leaning = stated.filter(({ name }) =>
    exported.exported.some(entry => entry.claim && entry.name === name),
  )

  const run = lean
    ? await runLean({
        lean,
        file,
        source: exported.lean,
        claims: leaning.map(one => one.name),
      })
    : undefined

  if (lean) {
    result.lean = lean
    result.version = await leanVersion(lean)
  }

  result.claims = stated.map(({ name, file: from }): HoldLeanClaim => {
    const verdict = run?.claims.find(one => one.name === name)

    if (verdict) {
      return {
        name,
        file: from,
        verdict: verdict.verdict,
        axioms: verdict.axioms,
        ...(verdict.error ? { reason: verdict.error } : {}),
      }
    }

    if (refused.has(name) || !leaning.some(one => one.name === name)) {
      return {
        name,
        file: from,
        verdict: 'declined',
        axioms: [],
        reason: refused.get(name) ?? 'the exporter did not write it',
      }
    }

    // exported, and Lean is missing: not checked, and the gate says so through `missing`
    return {
      name,
      file: from,
      verdict: 'refused',
      axioms: [],
      reason: 'Lean did not run',
    }
  })

  result.ok =
    !result.missing &&
    result.claims.every(one => one.verdict === 'checked')

  return result
}

// one item per claim, then the total. A missing Lean is a ✗ with the one line that installs it
export function reportLean(result: HoldLean): void {
  if (result.missing) {
    report({
      glyph: 'failed',
      kind: 'problem',
      verb: 'lean',
      subject: 'Lean 4 is not installed, so no claim was re-checked',
      message: ['Looked at TERM_LEAN, then the PATH.'],
      fields: [field('next', LEAN_INSTALL)],
    })
  }

  for (const claim of result.claims) {
    if (claim.verdict === 'checked') {
      report({
        glyph: 'done',
        verb: 'lean',
        subject: `${claim.name} checked`,
      })
    } else if (claim.verdict === 'axioms') {
      report({
        glyph: 'failed',
        kind: 'problem',
        verb: 'lean',
        subject: `${claim.name} checked, rests on ${claim.axioms.join(', ')}`,
      })
    } else if (claim.verdict === 'refused') {
      if (!result.missing) {
        report({
          glyph: 'failed',
          kind: 'problem',
          verb: 'lean',
          subject: `${claim.name} refused: ${claim.reason ?? ''}`,
        })
      }
    } else {
      report({
        glyph: 'failed',
        kind: 'problem',
        verb: 'lean',
        subject: `${claim.name} declined: ${claim.reason ?? ''}`,
      })
    }
  }

  if (result.dropped.length > 0) {
    report({
      glyph: 'warning',
      verb: 'lean',
      subject:
        'Loads left out of the joined program: the exporter reads no module binding yet',
      message: result.dropped,
    })
  }

  const of = (verdict: HoldLeanClaim['verdict']): number =>
    result.claims.filter(one => one.verdict === verdict).length

  report({
    glyph: result.ok ? 'done' : 'failed',
    verb: 'lean',
    subject: result.missing
      ? 'No claim was re-checked in Lean'
      : `${of('checked')} of ${result.claims.length} claims checked by Lean${result.version ? ` ${result.version}` : ''}`,
    counts: [
      count(of('refused'), 'refused'),
      count(of('axioms'), 'on an axiom'),
      count(of('declined'), 'declined'),
    ],
    ...(result.file ? { fields: [field('file', result.file)] } : {}),
  })
}
