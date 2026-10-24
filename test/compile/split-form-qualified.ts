// A FORM TWO MODULES DEFINE, BUILT BY ITS QUALIFIED CASE. `union.tree` defines a form `resolution` with cases, built
// as `make resolution/file`, matched by its own arms and named in its own signatures; `plain.tree` defines a record
// `resolution` of its own, built and read there; the entry loads both. The whole-program build splits the two forms
// by file (`resolution__in0_1`, check/scope.ts), and the qualified construction kept the written owner, so the
// checker refused it: 'expected resolution__in0_1, found resolution/file' (deck/make/code/deck/resolve.tree beside
// deck/deck/code/package/resolution.tree in line/base.tree's closure, term-compiler-0074). The separate build passed.
// Both builds must compile and run to the same answers.
// Run: npx tsx test/compile/split-form-qualified.ts

import { compile } from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'
import { transformSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

type Built = { ok: boolean; typescript?: string; diagnostics?: { name: string; message: string }[] }

const said = (r: Built): string => (r.ok ? 'ok' : (r.diagnostics ?? []).map(d => `${d.name}: ${d.message}`).join(' | '))

// the union, with qualified and bare constructions, a match over its own cases, and the form in type positions
const UNION = `form resolution
  case file
    link path, like text
  case missing
  case native
    link name, like text

task resolve-path
  take path, like text
  like resolution
  fork test
    hook test, is-equal(read(path), text <>)
    hook hold
      send back, make resolution/missing
  fork test
    hook test, is-equal(read(path), text <fs>)
    hook hold
      send back
        make resolution/native
          bind name, read path
  send back
    make resolution/file
      bind path, read path

task tell-resolution
  take found, like resolution
  like text
  fork case, read found
    case file
      send back, read path
    case native
      send back, read name
    case missing
      send back, text <missing>
  send back, text <none>

task tell-path
  take path, like text
  like text
  save found, like resolution
    call resolve-path
      read path
  send back
    call tell-resolution
      read found
`

// a record of the same name, built and read in its own file
const PLAIN = `form resolution
  link name, like text
  link size, like number

task make-resolution
  take name, like text
  like resolution
  send back
    make resolution
      bind name, read name
      bind size, code 3

task tell-plain
  take name, like text
  like text
  save found, like resolution
    call make-resolution
      read name
  send back, read found/name
`

const ENTRY = `load ./union
  find tell-path

load ./plain
  find tell-plain

task run
  like text
  save a, call tell-path(text <a/b>)
  save b, call tell-path(text <fs>)
  save c, call tell-path(text <>)
  save d, call tell-plain(text <pkg>)
  send back, text <{a} {b} {c} {d}>
`

const WANT = 'a/b fs missing pkg'

const resolverOf = (files: Record<string, string>): Resolver => path => {
  const name = path.replace(/^\.\//, '')
  const text = files[name]

  return text === undefined ? undefined : { file: `${name}.tree`, text }
}

const slug = (file: string): string => `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`

const dir = mkdtempSync(join(tmpdir(), 'term-split-form-'))

async function runModule(code: string, name: string): Promise<string> {
  writeFileSync(join(dir, name), transformSync(code, { loader: 'ts', format: 'esm' }).code)
  const module = (await import(`${pathToFileURL(join(dir, name)).href}?v=${Math.random()}`)) as { run(): string }

  return module.run()
}

async function main(): Promise<void> {
  const resolve = resolverOf({ union: UNION, plain: PLAIN })
  const merged = compile({ file: 'entry.tree', text: ENTRY }, { resolve, cache: new CompileCache() }) as Built
  ok('the whole-program build compiles', merged.ok, said(merged))
  ok('and it split the two forms by file', merged.ok && /[Rr]esolution(__in0_|In0_?)\d/.test(merged.typescript ?? ''), '')

  const separate = compileSeparate({ file: 'entry.tree', text: ENTRY }, { resolve, cache: new CompileCache(), modules: slug })
  ok('the separate build compiles', separate.ok, said(separate as Built))

  let mergedAnswer = ''
  let separateAnswer = ''

  if (merged.ok) {
    mergedAnswer = await runModule(merged.typescript!, 'merged.mjs')
    ok('the whole-program build runs to the answer', mergedAnswer === WANT, mergedAnswer)
  }

  if (separate.ok) {
    for (const [file, emit] of separate.modules) {
      writeFileSync(join(dir, slug(file).slice(2)), transformSync(emit.code, { loader: 'ts', format: 'esm' }).code)
    }

    const entry = (await import(`${pathToFileURL(join(dir, slug('entry.tree').slice(2))).href}?v=${Math.random()}`)) as {
      run(): string
    }
    separateAnswer = entry.run()
    ok('the separate build runs to the answer', separateAnswer === WANT, separateAnswer)
  }

  ok('the two builds behave the same', merged.ok && separate.ok && mergedAnswer === separateAnswer, `${mergedAnswer} / ${separateAnswer}`)

  rmSync(dir, { recursive: true, force: true })
  console.log(`\nsplit-form-qualified: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

void main()
