// CLI build test: `compileProject` compiles a project's .tree files to TypeScript under host/, mirroring the tree,
// and reports failures without writing output for them. Run: npx tsx test/call/run.ts

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileProject } from '@/code/call/make'

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

const root = mkdtempSync(join(tmpdir(), 'seed-project-'))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(
  join(root, 'code', 'double.tree'),
  'task double\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      code 2\n',
)

const good = compileProject(root)
expect('compiles the project file', good.compiled, 1)
expect('reports no failures', good.failed, 0)
const out = join(root, 'host', 'code', 'double.ts')
expect('writes emitted TypeScript under host/', existsSync(out), true)
expect(
  'emitted code defines the function',
  existsSync(out) &&
    readFileSync(out, 'utf8').includes('function double'),
  true,
)

// a broken file is reported, not written
writeFileSync(
  join(root, 'code', 'broken.tree'),
  'task broken\n  send back\n    read missing-name\n',
)
const mixed = compileProject(root)
expect('reports the broken file as a failure', mixed.failed, 1)
expect('still compiles the good file', mixed.compiled, 1)
expect(
  'surfaces the diagnostic',
  mixed.errors.some(e => e.includes('broken.tree')),
  true,
)

console.log(`\ncall: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
