// Re-export test: `bear @path` pulls a module into the program and re-exports its definitions, so anything that
// imports the bearing module sees them. This is how the native bindings (bind.tree) surface a platform's types: each
// wrapper leads with a run of `bear @...` lines. Run: npx tsx test/compile/bear.ts

import { compile } from '@cluesurf/make/code/compile/compile'
import type { Source } from '@cluesurf/make/code/compile/load'

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

const modules = new Map<string, string>([
  // the definition lives in `b`
  ['@app/b', 'form widget\n  link size, like number\n'],
  // `a` re-exports it with `bear` (and defines nothing of its own)
  ['@app/a', 'bear @app/b\n'],
  // `c` bears from `a` (transitive re-export)
  ['@app/c', 'bear @app/a\n'],
])
const resolve = (path: string): Source | undefined =>
  modules.has(path)
    ? { file: path, text: modules.get(path)! }
    : undefined

// importing the bearing module exposes the beared definition
const direct = compile(
  {
    file: 'main.tree',
    text: 'load @app/a\n  find widget\n\ntask one\n  like number\n  save w\n    make widget\n      bind size, code 5\n  send back, read w/size\n',
  },
  { resolve },
)
expect('a re-exports widget from b', direct.ok, true)
expect(
  'the re-exported form is usable (field read type-checks)',
  direct.ok && direct.typescript.includes('size'),
  true,
)

// re-export is transitive
const transitive = compile(
  {
    file: 'main.tree',
    text: 'load @app/c\n  find widget\n\ntask two\n  like number\n  save w\n    make widget\n      bind size, code 9\n  send back, read w/size\n',
  },
  { resolve },
)
expect('bear is transitive (c -> a -> b)', transitive.ok, true)

console.log(`\nbear: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
