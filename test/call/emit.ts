// `term make --emit <node|rust|swift|kotlin> <file.tree> --out <path>`: one program, one backend, one source file.
// Run: npx tsx test/call/emit.ts   (EMIT_KOTLIN=1 also builds and runs the Kotlin output, which takes ~20s)
//
// Runs the BUILT CLI (host/line.js), so it is the command a person types that is under test, not the function behind
// it. For each backend: the output names the program's tasks, and where the toolchain is installed it is BUILT with a
// small `main` appended and RUN, and must print the right answer. A program that does not check is REFUSED: non-zero
// exit, the diagnostic on stderr, and no file written.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TERM = process.cwd()
const LINE = join(TERM, 'host/line.js')
const ESBUILD = join(TERM, 'node_modules/.bin/esbuild')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 1500)}`)
  }
}

function skip(name: string, why: string): void {
  console.log(`skip  ${name}  (${why})`)
}

const have = (tool: string): boolean => spawnSync('which', [tool]).status === 0

const dir = mkdtempSync(join(tmpdir(), 'term-emit-'))
mkdirSync(join(dir, 'code'), { recursive: true })

// a stdlib import, so the closure and the native env rewrite are exercised, not only the entry file
const GOOD = join(dir, 'code', 'good.tree')
writeFileSync(
  GOOD,
  `load @term/base/code/list
  find list
  find push

task sum-to
  take size, like number
  like number
  save total, code 0
  save items
    make list
  walk size
    bind base, code 1
    bind head
      call add
        read size
        code 1
    hook next
      take site, name at
      call push
        read items
        read at
      save total
        call add
          read total
          read at
  send back, read total

task greet
  take name, like text
  like text
  send back, text <hello {{name}}>
`,
)

const BAD = join(dir, 'code', 'bad.tree')
writeFileSync(
  BAD,
  `task wrong
  take n, like number
  like number
  send back, text <not a number>
`,
)

function emit(target: string, file: string, out?: string) {
  return spawnSync('node', [LINE, 'make', '--emit', target, file, ...(out ? ['--out', out] : [])], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

// the answer every backend's main must print: 1 + 2 + ... + 100, then the greeting
const WANT = '5050 hello ada'

const MAIN: Record<string, string> = {
  node: `console.log(\`\${sumTo(100)} \${greet('ada')}\`)\n`,
  rust: `fn main() { println!("{} {}", sum_to(100), greet("ada".to_string())); }\n`,
  swift: `print("\\(sumTo(size: 100)) \\(greet(name: "ada"))")\n`,
  kotlin: `fun main() { println("\${sumTo(100L)} \${greet("ada")}") }\n`,
}

const NAMES: Record<string, RegExp[]> = {
  node: [/function sumTo\b/, /function greet\b/],
  rust: [/fn sum_to\s*\(/, /fn greet\s*\(/],
  swift: [/func sumTo\s*\(/, /func greet\s*\(/],
  kotlin: [/fun sumTo\s*\(/, /fun greet\s*\(/],
}

function run(command: string, args: string[]): { ok: boolean; out: string } {
  const done = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  return { ok: done.status === 0, out: `${done.stdout ?? ''}${done.stderr ?? ''}` }
}

for (const target of ['node', 'rust', 'swift', 'kotlin']) {
  const extension = { node: 'ts', rust: 'rs', swift: 'swift', kotlin: 'kt' }[target]!
  const out = join(dir, 'out', `good.${extension}`)
  const done = emit(target, 'code/good.tree', out)

  ok(`${target}: --emit exits 0`, done.status === 0, done.stderr)

  if (done.status !== 0 || !existsSync(out)) {
    continue
  }

  const source = readFileSync(out, 'utf8')

  for (const name of NAMES[target]!) {
    ok(`${target}: the output defines ${name.source}`, name.test(source), source.slice(0, 400))
  }

  // without --out, the same source on standard output
  const printed = emit(target, 'code/good.tree')
  ok(`${target}: without --out the source is printed`, printed.status === 0 && printed.stdout === source)

  if (target === 'kotlin') {
    ok('kotlin: every import is hoisted above the first declaration', !/\n(?:fun|class|object|val)[^\n]*\n[\s\S]*\nimport /.test(source))
  }

  const program = `${source}\n${MAIN[target]}`
  const name = `${target}-good`

  switch (target) {
    case 'node': {
      const file = join(dir, `${name}.ts`)
      const bundle = join(dir, `${name}.mjs`)
      writeFileSync(file, program)
      const built = run(ESBUILD, [file, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--log-level=error'])
      ok('node: the output bundles with esbuild', built.ok, built.out)
      const ran = run('node', [bundle])
      ok('node: it runs and prints the answer', ran.out.trim() === WANT, ran.out)
      break
    }
    case 'rust': {
      if (!have('rustc')) {
        skip('rust: build and run', 'rustc is not installed')
        break
      }

      const file = join(dir, `${name}.rs`)
      const exe = join(dir, name)
      writeFileSync(file, program)
      const built = run('rustc', ['--edition', '2021', '-A', 'warnings', file, '-o', exe])
      ok('rust: the output builds with rustc', built.ok, built.out)
      const ran = run(exe, [])
      ok('rust: it runs and prints the answer', ran.out.trim() === WANT, ran.out)
      break
    }
    case 'swift': {
      if (!have('swiftc')) {
        skip('swift: build and run', 'swiftc is not installed')
        break
      }

      const file = join(dir, `${name}.swift`)
      const exe = join(dir, name)
      writeFileSync(file, program)
      const built = run('swiftc', ['-suppress-warnings', file, '-o', exe])
      ok('swift: the output builds with swiftc', built.ok, built.out)
      const ran = run(exe, [])
      ok('swift: it runs and prints the answer', ran.out.trim() === WANT, ran.out)
      break
    }
    case 'kotlin': {
      if (!process.env.EMIT_KOTLIN) {
        skip('kotlin: build and run', 'set EMIT_KOTLIN=1')
        break
      }

      if (!have('kotlinc')) {
        skip('kotlin: build and run', 'kotlinc is not installed')
        break
      }

      const file = join(dir, `${name}.kt`)
      const jar = join(dir, `${name}.jar`)
      writeFileSync(file, program)
      const built = run('kotlinc', [file, '-include-runtime', '-nowarn', '-d', jar])
      ok('kotlin: the output builds with kotlinc', built.ok, built.out)
      const ran = run('java', ['-jar', jar])
      ok('kotlin: it runs and prints the answer', ran.out.trim() === WANT, ran.out)
      break
    }
  }
}

// a program that does not check is refused, on every backend, and nothing is written
for (const target of ['node', 'rust']) {
  const out = join(dir, 'out', `bad-${target}.txt`)
  const done = emit(target, 'code/bad.tree', out)

  ok(`${target}: a type error exits non-zero`, done.status === 1, `status ${done.status}`)
  // the closing item of the terminal output standard: `✗ make     Refused, nothing written`, then `1 error` on its facts
  ok(`${target}: the refusal names the error`, /Refused, nothing written[\s\S]*?\b\d+ errors?\b/.test(done.stderr), done.stderr)
  ok(`${target}: a refused emit writes nothing`, !existsSync(out))
}

// an unknown backend, and a missing file, are refused too
ok('an unknown backend is refused', emit('cobol', 'code/good.tree').status !== 0)
ok('a missing file is refused', emit('node', 'code/none.tree').status === 1)

console.log(`\nemit: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
