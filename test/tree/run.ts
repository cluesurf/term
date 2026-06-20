// The Seed test runner. A test file is ordinary Seed: a flat set of top-level test tasks, each a zero-argument task
// returning a boolean (it ends in a `want`). No `main`, no list, no closures. The runner mills the file to discover
// those tasks, compiles + imports the module, runs each (awaiting async ones), and exits non-zero on any failure. This
// is a host shim, NOT part of the compiler. Run: npx tsx test/tree/run.ts <file>. See note/library/seed/test-dsl.md.

import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { compile } from '@/code/compile/compile'
import { withNativeEnv, nativePrelude } from '@/code/compile/native'
import { render } from '@/code/parser/diagnostic'
import { toCamel } from '@/code/compile/typescript'
import { preprocessTests } from '@/test/tree/preprocess'
import type { Source } from '@/code/compile/load'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = resolvePath(here, '..', '..', '..', 'base.tree')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/base/'
  if (!path.startsWith(prefix)) return undefined
  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)
  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}
const readRuntime = (path: string): string | undefined => {
  const prefix = '@cluesurf/base/'
  if (!path.startsWith(prefix)) return undefined
  const file = join(baseTree, path.slice(prefix.length))
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

// the entry file's own top-level test tasks: a zero-argument task that returns a boolean. Imported helpers (`want`,
// `power`) take arguments, so they are excluded. Order is source order. The name is shown with dashes as spaces.
function discoverTests(text: string): Array<string> {
  const parsed = parse({ file: 'main.tree', text })
  if (!parsed.ok) return []
  const built = mill(parsed.tree, 'main.tree')
  if (!built.ok) return []
  return built.program
    .filter(
      node =>
        node.form === 'function' &&
        node.params.length === 0 &&
        node.result?.kind === 'boolean',
    )
    .map(node => (node as { name: string }).name)
}

async function runFile(file: string): Promise<number> {
  // expand `test <phrase>` blocks (surface B2) into top-level tasks before the compiler sees the file; a file with no
  // `test` blocks passes through unchanged
  const { text, labels } = preprocessTests(readFileSync(file, 'utf8'))
  const names = discoverTests(text)
  const result = compile(
    { file: 'main.tree', text },
    { resolve: withNativeEnv('node', stdlib) },
  )
  if (!result.ok) {
    for (const d of result.diagnostics)
      console.log(render(d, text.split('\n'), false))
    console.log(`\n${file}: did not compile`)
    return 1
  }
  const prelude = nativePrelude(result.program, 'node', readRuntime)
  const js = transformSync(`${prelude}\n${result.typescript}`, {
    loader: 'ts',
    format: 'esm',
  }).code
  const dir = mkdtempSync(join(tmpdir(), 'seed-test-'))
  const out = join(dir, 'module.mjs')
  writeFileSync(out, js)
  const mod = (await import(pathToFileURL(out).href)) as Record<
    string,
    (() => Promise<boolean> | boolean) | undefined
  > & { main?: () => Promise<{ pass: number; fail: number }> | { pass: number; fail: number } }

  // transitional: a file that still uses the `main` + `run(list)` model runs its main and reports its tally
  if (names.length === 0 && typeof mod.main === 'function') {
    const report = await mod.main()
    console.log(`\n${report.pass} pass, ${report.fail} fail`)
    return report.fail > 0 ? 1 : 0
  }
  if (names.length === 0) {
    console.log(`${file}: no tests found`)
    return 1
  }

  let pass = 0
  let fail = 0
  for (const name of names) {
    const display = labels.get(name) ?? name.replace(/-/g, ' ')
    const held = await mod[toCamel(name)]!()
    if (held) {
      pass++
      console.log(`ok    ${display}`)
    } else {
      fail++
      console.log(`FAIL  ${display}`)
    }
  }
  console.log(`\n${pass} pass, ${fail} fail`)
  return fail > 0 ? 1 : 0
}

const target = process.argv[2]
if (!target) {
  console.log('usage: npx tsx test/tree/run.ts <file.tree>')
  process.exit(2)
}
process.exit(await runFile(resolvePath(target)))
