// A `test <phrase>` whose phrase starts with a digit names a task that starts with a letter. The phrase became
// `task 2a-3b-1-is-found`, emitted as an identifier esbuild refused with `Syntax error "a"` and no pointer to the test
// (deck/test/test/affine-synthesis.tree, 2026-10-05). The slug now takes a leading `test-`, in test-preprocess.ts
// and in its port, call/code/work/test-text.tree, which this holds equal to it over a set of phrases.
// Run: npx tsx test/call/test-slug.ts

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { nativePrelude, withNativeEnv } from '@term/make/code/compile/native'
import { preprocessTests } from '@term/call/code/test-preprocess'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const phrases = ['2a + 3b + 1 is found', 'max holds', '3', '!!!', '  9 lives  ', 'a2 b3', '0x1f is a number', 'Ünïcode 4 you']

const slugOf = (phrase: string): string => {
  const done = preprocessTests(`test <${phrase}>\n  want hold, true\n`)

  return [...done.labels.keys()][0] ?? ''
}

const preprocessed = phrases.map(slugOf)

ok('a phrase that starts with a digit names a task that starts with a letter', preprocessed.every(slug => /^[a-z]/.test(slug)), preprocessed.join(' | '))
ok('`2a + 3b + 1 is found` is `test-2a-3b-1-is-found`', preprocessed[0] === 'test-2a-3b-1-is-found', preprocessed[0])
ok('a phrase that starts with a letter keeps its slug', preprocessed[1] === 'max-holds', preprocessed[1])

// the port, compiled as it is written, beside the TypeScript it was ported from
const file = new URL('../../deck/call/code/work/test-text.tree', import.meta.url)
const built = compile(
  { file: 'test-text.tree', text: readFileSync(file, 'utf8') },
  { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['slugify'], leanOf: () => true } as never,
)

ok('test-text.tree builds', built.ok, built.ok ? '' : built.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))

if (built.ok) {
  const dir = mkdtempSync(join(tmpdir(), 'term-test-slug-'))
  const out = join(dir, 'module.mjs')
  // the regex engine is a runtime global, defined by the prelude as task/port-build.ts writes it
  const prelude = nativePrelude(built.program, 'node', path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))
  const defined = new Set([...(prelude ?? '').matchAll(/^const ([A-Za-z_$][\w$]*) =/gm)].map(match => match[1]!))
  const body = built.typescript
    .split('\n')
    .filter(line => {
      const declared = /^declare const ([A-Za-z_$][\w$]*)\s*:/.exec(line)

      return !declared || !defined.has(declared[1]!)
    })
    .join('\n')
  writeFileSync(out, transformSync(`${prelude ?? ''}\n${body}`, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(out).href)) as { slugify: (phrase: string) => string }
  const ported = phrases.map(phrase => mod.slugify(phrase))

  ok('the port slugs every phrase as the TypeScript does', ported.join('|') === preprocessed.join('|'), `port ${ported.join(' | ')}\n        ts   ${preprocessed.join(' | ')}`)
}

console.log(`\ntest-slug: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
