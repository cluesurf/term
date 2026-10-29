// A port's native prelude carries each runtime shim ONCE (term-cli-in-term-0127).
//
// A port that loaded @term/base/json beside a compiler module (deck/flow/code/framing.tree, test/code/model-request.tree)
// got the json runtime shim written into it twice, `const json` declared twice, and esbuild refused the port although
// `term make` passed. This builds such a port the way task/port-build.ts does (its own `portContent`), from a source held
// in memory at a path under deck/test/code (nothing is written), and holds:
//   - every top-level `const <name> =` of the content is declared once
//   - esbuild transforms the content (the refusal the lanes hit)
//
// Run: npx tsx test/call/port-prelude-once.ts      (from deck/term/deck/term)

import { join } from 'node:path'
import { transform } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf } from '@term/call/code/role-of'
import { portContent } from '../../task/port-build'

const TERM = process.cwd()
const ROOT = join(TERM, 'deck', 'test')

const CASES: { name: string; text: string }[] = [
  {
    name: 'json beside a compiler module',
    text: `load @term/base/json
  find parse, name parse-json

load @term/make/compile/main-entry
  find whitespace-code

task probe
  take text, like text
  like dynamic
  back parse-json(text)
`,
  },
  {
    name: 'json beside a compiler module and <global:JSON>',
    text: `load @term/base/json
  find parse, name parse-json

load @term/make/compile/main-entry
  find whitespace-code

dock load
  load <global:JSON>, name json-global

task probe
  take text, like text
  like dynamic
  back parse-json(text)
`,
  },
  {
    name: 'json and <global:JSON> alone',
    text: `load @term/base/json
  find parse, name parse-json

dock load
  load <global:JSON>, name json-global

task probe
  take text, like text
  like dynamic
  back parse-json(text)
`,
  },
]

let passed = 0
let failed = 0
const ok = (name: string, holds: boolean, detail = ''): void => {
  console.log(
    `${holds ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`,
  )
  passed += holds ? 1 : 0
  failed += holds ? 0 : 1
}

for (const one of CASES) {
  const file = join(ROOT, 'code', '__port-prelude-once.tree')
  const result = compile(
    { file, text: one.text },
    {
      resolve: projectResolver(ROOT),
      leanOf: projectLeanOf(ROOT),
      library: true,
    },
  )

  if (!result.ok) {
    ok(
      `${one.name}: compiles`,
      false,
      result.diagnostics
        .slice(0, 3)
        .map(d => `${d.name}: ${d.message}`)
        .join('; '),
    )
    continue
  }

  const content = portContent(result.program, result.typescript)
  const names = [
    ...content.matchAll(/^(?:export )?const ([A-Za-z_$][\w$]*) =/gm),
  ].map(match => match[1]!)
  const twice = [
    ...new Set(
      names.filter((name, index) => names.indexOf(name) !== index),
    ),
  ]
  ok(
    `${one.name}: each top-level const once`,
    twice.length === 0,
    twice.join(', '),
  )

  let refusal = ''

  try {
    await transform(content, { loader: 'ts', format: 'esm' })
  } catch (error) {
    refusal = (error as Error).message.split('\n').slice(0, 2).join(' ')
  }

  ok(`${one.name}: esbuild takes it`, refusal === '', refusal)
}

// the summary line `pnpm term:test` counts (task/term/test.ts `summary`): without it the gate read a clean exit as
// `ok, 0 pass`, so a run that checked nothing could not be told from one that checked everything
console.log(`port-prelude-once: ${passed} pass, ${failed} fail`)
console.log(failed === 0 ? 'status: PASS' : `status: FAIL (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
