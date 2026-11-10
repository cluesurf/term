// Seal a Term project with the law library, as `term knit` does before every round (deck/call/code/work/knit/law-library.tree):
// each file that fuses a library law gets the law's template text below the marker at its end, and every named law is
// checked to be the library's statement with the project's fill. Reports by default, writes only with --commit.
//
// It runs the Term ports, emitted under deck/call/host/port/ (pnpm run make:port), the same code the CLI runs.
//
// Run: node ../../../../node_modules/tsx/dist/cli.mjs task/term/knit-seal.ts <project> [--commit], from the Term root
//   (the library fixture: test/assurance/library, resealed whenever a library law's text changes)

import path from 'node:path'
import { readFileSync } from 'node:fs'
import { checkInstances, fusesOf, libraryLaw, libraryNames, ownText, parse, sealed, seal } from '@term/call/code/work/knit/law-library'
import type { LibraryLaw } from '@term/call/code/work/knit/law-library'
import { packageRoot } from '@term/call/code/work/knit/project-frame'
import { makeRoleReader } from '@term/call/code/work/build/role-reading'
import { faceLeanReader, faceRoleReader } from '@term/call/code/work/build/host-faces'

const args = process.argv.slice(2)
const commit = args.includes('--commit')
const project = path.resolve(args.find(arg => !arg.startsWith('--')) ?? '.')
const root = packageRoot()
const laws: LibraryLaw[] = libraryNames(root).flatMap(name => {
  const found = libraryLaw(root, name)
  return found.form === 'some' ? [found.value] : []
})
const file = path.join(project, 'code/law.tree')
const stale = sealed(readFileSync(file, 'utf8'), laws) !== readFileSync(file, 'utf8')

if (commit) {
  console.log(`sealed: ${seal(project, laws).join(', ') || 'nothing changed'}`)
} else {
  console.log(stale ? 'code/law.tree is not sealed with the library as it stands: run again with --commit' : 'code/law.tree is sealed')
}

// the laws the file fuses, read through the parser
const parsed = parse({ file, text: ownText(readFileSync(file, 'utf8')) })
const templates = new Set(parsed.ok ? fusesOf(parsed.tree).map(fuse => fuse.template) : [])
const fused = laws.filter(law => templates.has(law.template)).map(law => law.name)
const reader = makeRoleReader(project)
for (const one of checkInstances({ project, required: fused, laws, roleOf: faceRoleReader(reader), leanOf: faceLeanReader(reader) })) {
  console.log(`${one.ok ? 'instance' : 'REFUSED '}  ${one.law}${one.ok ? '' : `: ${one.problem}`}`)
}
