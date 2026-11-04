// Seal a Term project with the law library, as `term knit` does before every round (deck/call/code/knit-law.ts):
// each file that fuses a library law gets the law's template text below the marker at its end, and every named law is
// checked to be the library's statement with the project's fill. Reports by default, writes only with --commit.
//
// Run: pnpm exec tsx task/term/knit-seal.ts <project> [--commit]
//   (the library fixture: test/assurance/library, resealed whenever a library law's text changes)

import path from 'node:path'
import { readFileSync } from 'node:fs'
import { parse } from '@term/make/code/parser/tree'
import { checkInstances, fusesOf, libraryLaw, libraryNames, ownText, sealed, seal } from '@term/call/code/knit-law'
import { packageRoot } from '@term/call/code/knit'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'

const args = process.argv.slice(2)
const commit = args.includes('--commit')
const project = path.resolve(args.find(arg => !arg.startsWith('--')) ?? '.')
const root = packageRoot()
const laws = libraryNames(root).flatMap(name => libraryLaw(root, name) ?? [])
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
for (const one of checkInstances({ project, required: fused, laws, roleOf: projectRoleOf(project), leanOf: projectLeanOf(project) })) {
  console.log(`${one.ok ? 'instance' : 'REFUSED '}  ${one.law}${one.ok ? '' : `: ${one.problem}`}`)
}
