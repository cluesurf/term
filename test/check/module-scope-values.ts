// Module scope for a task passed as a VALUE and for a host BIND (term-compiler-0038, term-compiler-0039). A name is
// scoped to its module (test/check/module-scope.ts holds the rest): a value reference binds by import exactly as a
// call does, and a `bind` two files define is split by file as a task is. Both stopped the CLI ports from loading each
// other: work/context/emission.tree passes read-runtime as a value beside work/cask/toolchain.tree's read-runtime, and
// work/context/app-scope.tree and work/cask/host-value.tree each bind `refuse`.
//
// Run: npx tsx test/check/module-scope-values.ts

import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// a package of `@app/<name>` modules, and a main file loading some of them
function build(files: Record<string, string>, main: string) {
  const resolve = (path: string): Source | undefined =>
    files[path] !== undefined
      ? {
          file: `${path.slice('@app/'.length)}.tree`,
          text: files[path]!,
        }
      : undefined

  return compile({ file: 'main.tree', text: main }, { resolve })
}

const said = (result: ReturnType<typeof build>): string =>
  result.ok
    ? result.typescript
    : result.diagnostics.map(d => d.message).join(' | ')

async function runOf(
  typescript: string,
): Promise<Record<string, () => unknown>> {
  const { transformSync } = await import('esbuild')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const file = join(
    mkdtempSync(join(tmpdir(), 'term-module-scope-values-')),
    'module.mjs',
  )
  writeFileSync(
    file,
    transformSync(typescript, { loader: 'ts', format: 'esm' }).code,
  )

  return (await import(pathToFileURL(file).href)) as Record<
    string,
    () => unknown
  >
}

async function check(
  name: string,
  result: ReturnType<typeof build>,
  want: unknown,
): Promise<void> {
  ok(name, result.ok, said(result))

  if (result.ok) {
    try {
      const got = (await runOf(result.typescript)).run?.()
      ok(`${name}: runs`, got === want, String(got))
    } catch (error) {
      ok(`${name}: runs`, false, String(error))
    }
  }
}

const MAIN = `load @app/a\n  find go\n\nload @app/b\n  find other\n\ntask run\n  like text\n  send back, <{go()} {other()}>\n`
const READER_B = `task reader\n  take file, like text\n  like text\n  send back, text <b>\n\ntask other\n  like text\n  send back\n    call reader\n      text <x>\n`

// a task passed as a VALUE where some form has a field of its name: two files defining `reader` split it by file, and
// the value reference in `bind reader, read reader` was left as written (the name matched a field, which only a match
// arm makes a local) and failed as an unknown name
{
  const a = `form ask\n  link reader, like dynamic\n\ntask reader\n  take file, like text\n  like text\n  mark private\n  send back, text <a>\n\ntask go\n  like text\n  save asked\n    make ask\n      bind reader, read reader\n  send back, call asked/reader(text <x>)\n`
  await check(
    'a task passed as a value binds by import where a form has a field of its name',
    build({ '@app/a': a, '@app/b': READER_B }, MAIN),
    'a b',
  )
}

// and with no field of the name anywhere
{
  const a = `task reader\n  take file, like text\n  like text\n  send back, text <a>\n\ntask apply\n  take f, like task\n    take file, like text\n    like text\n  like text\n  send back, call f(text <x>)\n\ntask go\n  like text\n  send back, call apply(read reader)\n`
  await check(
    'a task passed as a value binds by import',
    build({ '@app/a': a, '@app/b': READER_B }, MAIN),
    'a b',
  )
}

// inside a match arm the variant's field IS a local by its own name, so a split task of that name is not what the
// arm's reference means
{
  const a = `form shape\n  case box\n    link reader, like text\n  case none\n\ntask reader\n  take file, like text\n  like text\n  send back, text <a>\n\ntask go\n  like text\n  save s\n    make box\n      bind reader, text <field>\n  sift s\n    case box\n      send back, read reader\n    case none\n      send back, call reader(text <x>)\n  send back, call reader(text <x>)\n`
  await check(
    "a match arm's field stays the local it names, beside a split task of its name",
    build({ '@app/a': a, '@app/b': READER_B }, MAIN),
    'field b',
  )
}

// a host BIND is scoped to its module like a task: two files each binding `refuse`, at one and at two arguments
{
  const a = `bind refuse\n  take message, like text\n  like text\n  case node\n    text <("one:" + $message)>\n\ntask go\n  like text\n  send back\n    call refuse\n      text <a>\n`
  const b = `bind refuse\n  take message, like text\n  take failure, like text\n  like text\n  case node\n    text <("two:" + $message + $failure)>\n\ntask other\n  like text\n  send back\n    call refuse\n      text <b>\n      text <c>\n`
  await check(
    'two files binding one name at two arities each call their own',
    build({ '@app/a': a, '@app/b': b }, MAIN),
    'one:a two:bc',
  )
}

// the same arity: told apart only by file
{
  const a = `bind tag\n  take message, like text\n  like text\n  case node\n    text <("a:" + $message)>\n\ntask go\n  like text\n  send back\n    call tag\n      text <x>\n`
  const b = `bind tag\n  take message, like text\n  like text\n  case node\n    text <("b:" + $message)>\n\ntask other\n  like text\n  send back\n    call tag\n      text <y>\n`
  await check(
    'two files binding one name at one arity each call their own',
    build({ '@app/a': a, '@app/b': b }, MAIN),
    'a:x b:y',
  )
}

// a file that imports a bind by name from a module calls that module's, beside another module's bind of the name
{
  const a = `bind tag\n  take message, like text\n  like text\n  case node\n    text <("a:" + $message)>\n`
  const b = `bind tag\n  take message, like text\n  like text\n  case node\n    text <("b:" + $message)>\n\ntask other\n  like text\n  send back\n    call tag\n      text <y>\n`
  const main = `load @app/a\n  find tag\n\nload @app/b\n  find other\n\ntask run\n  like text\n  send back, <{tag(<x>)} {other()}>\n`
  await check(
    "an imported bind is the module's it was found in",
    build({ '@app/a': a, '@app/b': b }, main),
    'a:x b:y',
  )
}

console.log(`\nmodule-scope-values: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
