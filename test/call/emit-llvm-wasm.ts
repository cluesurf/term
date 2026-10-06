// `term make --emit llvm` and `--emit wasm`, the two targets built through the program's Rust (call/code/native-build.ts
// `buildThroughRust`, note/term/plan/backends-complete.md step 4). The IR needs rustc alone and is always checked. A
// build of the IR needs `llc` from rustup's llvm-tools, and a module needs the wasm32-wasip1 target: where either is
// missing, the refusal must name the rustup command that installs it, and where it is present the program must answer.
// Run: npx tsx test/call/emit-llvm-wasm.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 1200)}`)
  }
}

const LINE = join(dirname(fileURLToPath(import.meta.url)), '../../host/line.js')
const have = (tool: string): boolean => spawnSync('which', [tool], { encoding: 'utf8' }).status === 0

if (!have('rustc')) {
  console.log('skip  rustc not installed')
  console.log(`\nemit-llvm-wasm: 0 pass, 0 fail`)
  process.exit(0)
}

const sysroot = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).stdout.trim()
const triple = /^host: (.+)$/m.exec(spawnSync('rustc', ['--version', '--verbose'], { encoding: 'utf8' }).stdout)?.[1]?.trim() ?? ''
const hasLlc = existsSync(join(sysroot, 'lib', 'rustlib', triple, 'bin', 'llc'))
const hasWasi = existsSync(join(sysroot, 'lib', 'rustlib', 'wasm32-wasip1', 'lib'))

const project = mkdtempSync(join(tmpdir(), 'term-emit-llvm-'))
mkdirSync(join(project, 'code'))
writeFileSync(join(project, 'deck.tree'), 'deck @probe/emit-llvm\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')

writeFileSync(
  join(project, 'code/answer.tree'),
  `task double
  take n, like number
  like number
  back multiply(n, 2)

task run
  like text
  back <answer {double(21)}>
`,
)

// a program that names a crate: refused, since neither target takes one
writeFileSync(
  join(project, 'code/money.tree'),
  `load @term/base/decimal
  find make-big-decimal
  find decimal-add

task run
  like text
  back text(decimal-add(make-big-decimal(<0.1>), make-big-decimal(<0.2>)))
`,
)

writeFileSync(join(project, 'code/library.tree'), 'task helper\n  take n, like number\n  like number\n  back n\n')

// stderr with the report's wrapping undone, so a command broken across two lines still reads as one
const term = (...args: string[]) => {
  const ran = spawnSync(process.execPath, [LINE, ...args], { cwd: project, encoding: 'utf8', maxBuffer: 1 << 26 })

  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr.replace(/\s+/g, ' ') }
}

// the IR, to stdout and to --out
const ir = term('make', '--emit', 'llvm', 'code/answer.tree')
ok('llvm: the IR is printed, with the entry and a main in it', ir.status === 0 && /define .*@main\(/.test(ir.stdout) && /target triple/.test(ir.stdout), `${ir.status} ${ir.stdout.slice(0, 300)} ${ir.stderr}`)

const out = term('make', '--emit', 'llvm', 'code/answer.tree', '--out', 'out/answer.ll')
ok('llvm: --out writes the IR and prints nothing', out.status === 0 && out.stdout === '' && /target triple/.test(existsSync(join(project, 'out/answer.ll')) ? readFileSync(join(project, 'out/answer.ll'), 'utf8') : ''), `${out.status} ${out.stderr}`)

// built from the IR
const llvmRun = term('make', '--emit', 'llvm', 'code/answer.tree', '--run')

if (hasLlc) {
  ok('llvm: --run builds the IR with llc and answers', llvmRun.status === 0 && llvmRun.stdout === 'answer 42', `${llvmRun.status} ${llvmRun.stdout} ${llvmRun.stderr}`)
} else {
  ok('llvm: --run without llc is refused, naming rustup component add llvm-tools', llvmRun.status !== 0 && /rustup component add llvm-tools/.test(llvmRun.stderr), `${llvmRun.status} ${llvmRun.stderr}`)
}

// the module
const wasmRun = term('make', '--emit', 'wasm', 'code/answer.tree', '--run')

if (hasWasi) {
  ok('wasm: --run builds the module and node runs it under WASI', wasmRun.status === 0 && wasmRun.stdout === 'answer 42', `${wasmRun.status} ${wasmRun.stdout} ${wasmRun.stderr}`)
} else {
  ok('wasm: without the target it is refused, naming rustup target add wasm32-wasip1', wasmRun.status !== 0 && /rustup target add wasm32-wasip1/.test(wasmRun.stderr), `${wasmRun.status} ${wasmRun.stderr}`)
}

for (const target of ['llvm', 'wasm']) {
  const money = term('make', '--emit', target, 'code/money.tree', '--run')
  ok(`${target}: a program naming a crate is refused, naming the crate`, money.status !== 0 && /num-bigint|num_bigint/.test(money.stderr), `${money.status} ${money.stderr}`)

  const library = term('make', '--emit', target, 'code/library.tree', '--run')
  ok(`${target}: a program with nothing to start is refused, naming --main`, library.status !== 0 && /--main/.test(library.stderr), `${library.status} ${library.stderr}`)
}

console.log(`\nemit-llvm-wasm: ${pass} pass, ${fail} fail (llc ${hasLlc ? 'present' : 'absent'}, wasm32-wasip1 ${hasWasi ? 'present' : 'absent'})`)

if (fail > 0) {
  process.exit(1)
}
