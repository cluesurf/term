// Generate the cask bridge for one page, by hand: the webview shims and the app's dispatcher. `term make --target`
// does this before every build; this is the same generator run alone, and with --check it holds what is on disk to
// what it would write, which is the cask/generate suite in `pnpm term:test`.
//
//   pnpm term:cask-generate --page deck/cask/test/smoke/page.tree            report
//   pnpm term:cask-generate --page deck/cask/test/smoke/page.tree --commit   write
//   pnpm term:cask-generate --page deck/cask/test/smoke/page.tree --check    exit 1 on drift
//
// dispatch.tree lands beside the page unless --out says otherwise. Runs from the Term root, the way every other
// term task does. The generator itself is deck/call/code/cask-generate.ts.
import { relative, resolve as resolvePath } from 'node:path'
import { generateBridge } from '@term/call/code/cask-generate'

// a suite entry cannot pass arguments, so `pnpm term:test` hands them through the environment instead
const argv = [...process.argv.slice(2), ...(process.env.CASK_GENERATE_ARGS ?? '').split(' ').filter(Boolean)]
const pageArg = argv.includes('--page') ? argv[argv.indexOf('--page') + 1] : undefined
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined
const commit = argv.includes('--commit')
const check = argv.includes('--check')

if (!pageArg) {
  console.error('usage: pnpm term:cask-generate --page <page.tree> [--out <dir>] [--commit | --check]')
  process.exit(2)
}

const page = resolvePath(pageArg)
const out = outArg ? resolvePath(outArg) : resolvePath(page, '..')
const report = generateBridge({ page, out, commit })

console.log(`generate  ${relative(process.cwd(), page)} docks ${report.modules.length} native module${report.modules.length === 1 ? '' : 's'}: ${report.modules.join(', ') || 'none'}`)
console.log(`generate  ${report.carried} commands carried, ${report.refused.length} refused`)

for (const one of report.refused) {
  console.log(`generate    ${one.module}/${one.task}: not carried, ${one.reason}`)
}

for (const one of report.drift) {
  console.log(`generate    ${relative(process.cwd(), one.file)}: ${one.written ? 'written' : check ? 'differs from disk' : 'differs from disk, pass --commit to write'}`)
}

if (report.drift.length === 0) {
  console.log('generate  everything on disk is what would be written')
}

if (check) {
  const total = report.modules.length + 1
  console.log(`cask/generate: ${total - report.drift.length} pass, ${report.drift.length} fail`)
  process.exit(report.drift.length === 0 ? 0 : 1)
}
