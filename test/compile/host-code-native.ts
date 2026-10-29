// tree/code on the native backends: `@term/host`'s codec with its whole stdlib closure (the float bits included)
// compiled for Rust, Swift and Kotlin, built with the real toolchain, and run. Each backend must write the reference
// codec's bytes (compile/host-code.ts) for the same data, and decode then encode them back unchanged. A backend whose
// toolchain is not installed is skipped, never failed. Run: npx tsx test/compile/host-code-native.ts
// (HN_ONLY=rust|swift|kotlin runs one backend.)

import { runDir } from './run-dir'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { resolvePackagePath, sourceOf } from '@term/make/code/resolve'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import {
  bindModules,
  stampModule,
} from '@term/make/code/check/bind-modules'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import {
  emitKotlin,
  hoistKotlinImports,
} from '@term/make/code/compile/kotlin'
import type { Program } from '@term/make/code/compile/node'
import { expandData, readDataText } from '@term/make/code/compile/host'
import {
  decodeTree,
  encodeTree,
} from '@term/make/code/compile/host-code'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    // a toolchain prints warnings first and the error last, so a long failure keeps its end
    console.log(
      `FAIL  ${name}  ${info.length > 2400 ? `...${info.slice(-2400)}` : info}`,
    )
  }
}

function skipped(name: string, why: string): void {
  skip++
  console.log(`skip  ${name}  (${why})`)
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const FIXTURE = join(TERM, 'deck/host/test/fixture')
const PACKS: Record<string, string> = {
  base: join(TERM, 'deck/base'),
  host: join(TERM, 'deck/host'),
}
const SEP = '\u001e'

const resolver = (path: string, from: string): Source | undefined => {
  if (path.startsWith('./') || path.startsWith('../')) {
    const base = join(from.replace(/\/[^/]*$/, ''), path)

    for (const file of [`${base}.tree`, join(base, 'base.tree')]) {
      if (existsSync(file)) {
        return { file, text: readFileSync(file, 'utf8') }
      }
    }

    return undefined
  }

  const found = /^@term\/(base|host)\/(.*)$/.exec(path)

  return found
    ? sourceOf(
        resolvePackagePath({ dir: PACKS[found[1]!]!, rest: found[2]! }),
      )
    : undefined
}

const readRuntime = (p: string): string | undefined =>
  existsSync(p) ? readFileSync(p, 'utf8') : undefined

const ENTRY = `load @term/host/code/base
  find read
  find to-code
  find to-code-all
  find from-code
  find code-defect

load @term/base/exception
  find failure

load @term/base/bytes
  find to-hex
  find from-hex

# the tree/code of a data file's text, as hex
task code-hex
  take input, like text
  like text
  send back
    call to-hex
      call to-code
        call read(read input)

# decode then encode, as hex
task recode-hex
  take input, like text
  like text
  send back
    call to-hex
      call to-code-all
        call from-code
          call from-hex(read input)

# how a stream is refused: the defect's name, byte and message, or \`accepted\`
task refusal-of
  take input, like text
  like text
  fork
    mark unsafe
    save values
      call from-code
        call from-hex(read input)
    send back, text <accepted>
  halt take
    take defect
    fork case, read defect
      case code-defect
        send back, text <{problem} @{at}: {reason}>
      case failure
        send back, text <failure: {note}>
  send back, text <another defect>
`

const ROOTS = ['code-hex', 'recode-hex', 'refusal-of']

// the data each backend encodes: the spec's worked example, every kind of literal in its shortest form, text past
// ASCII, records sharing a shape, and the two fixtures
const ALL_INPUTS: string[] = [
  'list member\n  mesh\n    host name, <ada>\n    host age, 36\n    host active, true\n  mesh\n    host name, <alan>\n    host age, 41\n    host active, false\n',
  // `1e300` is left out: @term/host's own text reader panics on it on Rust (a decimal with an exponent, read past the
  // end of its text), before the codec is reached. Recorded in note/project/term/host/10-code.md
  'host a, -3.5\nhost b, true\nhost c, void\nhost f, 2.0\nhost g, 0.1\nhost h, -40\nhost i, 1099511627776\nhost k, -0.0\nhost l, <>\n',
  'host a, <é 世界 😀 👩‍👩‍👧>\nhost b, <line\\nbreak \\<x\\>>\n',
  readFileSync(join(FIXTURE, 'basic.tree'), 'utf8'),
  readFileSync(join(FIXTURE, 'anchors.tree'), 'utf8'),
]

// HCN_INPUTS=0,2 runs only those inputs, to find which one a backend trips on
const INPUTS = process.env.HCN_INPUTS
  ? process.env.HCN_INPUTS.split(',').map(at => ALL_INPUTS[Number(at)]!)
  : ALL_INPUTS

function reference(text: string): string {
  const read = readDataText({ file: 'input', text })

  if (!read.ok) {
    return read.diagnostics.map(d => d.message).join(' | ')
  }

  const expanded = expandData(read.data, 'input')

  return expanded.ok
    ? Buffer.from(encodeTree(expanded.data)).toString('hex')
    : expanded.diagnostics.map(d => d.message).join(' | ')
}

const WANT = INPUTS.map(reference)

// ---- the native edges (item term-self-host-001-0299, decision 041 section 3) ----

const H = 'd3 54 52 01'

function leb(value: bigint): string {
  const out: string[] = []
  let left = value

  do {
    const low = Number(left & 127n)
    left >>= 7n
    out.push(
      (left > 0n ? low | 128 : low).toString(16).padStart(2, '0'),
    )
  } while (left > 0n)

  return out.join(' ')
}

// one frame of `kind` holding `body`, its length a varint
function frame(kind: string, body: string): string {
  const bytes = body.split(' ').filter(Boolean)

  return `${H} ${kind} ${leb(BigInt(bytes.length))} ${bytes.join(' ')}`
}

const compact = (stream: string): string =>
  stream.split(' ').filter(Boolean).join('')

// refusals whose message carries a decimal: each native backend must give the TypeScript port's name, byte and
// message, the decimal written as TypeScript writes it
const REFUSALS: { stream: string; name: string }[] = [
  // a count past 2^53 - 1
  {
    stream: `${H} 01 0a 9c ff ff ff ff ff ff ff ff 01`,
    name: 'too-large',
  },
  // a frame length past 2^53 - 1
  { stream: `${H} 01 ${'ff '.repeat(8)}7f e0`, name: 'too-large' },
  // a compressed frame's declared size at 2^53, past what a length holds
  { stream: frame('02', leb(2n ** 53n)), name: 'too-large' },
  // a compressed frame's declared size past the 64 MiB frame limit
  { stream: frame('02', leb(2n ** 27n)), name: 'too-large' },
  // values nested past the depth limit of 256
  { stream: frame('01', `${'81 '.repeat(257)}e0`), name: 'too-deep' },
]

function portRefusal(stream: string): string {
  const decoded = decodeTree(
    Uint8Array.from(Buffer.from(compact(stream), 'hex')),
  )

  return decoded.ok
    ? 'accepted'
    : `${decoded.problem.name} @${decoded.problem.at}: ${decoded.problem.message}`
}

const REFUSED = REFUSALS.map(one => portRefusal(one.stream))

// integers past 64 bits: the format carries them (TypeScript reads the nearest double), a native number cannot, so each
// native backend refuses them as `too-large` at the integer's head byte (6), naming its width in bits
const WIDE: { body: string; value: bigint }[] = [
  {
    body: '1c ff ff ff ff ff ff ff ff ff 01',
    value: 2n ** 64n - 1n + 28n,
  },
  {
    body: '3c ff ff ff ff ff ff ff ff ff 01',
    value: 2n ** 64n - 1n + 28n + 1n,
  },
  {
    body: '1c 80 80 80 80 80 80 80 80 80 80 01',
    value: 2n ** 70n + 28n,
  },
]

const WIDE_WANT = WIDE.map(
  one =>
    `too-large @6: an integer of ${one.value.toString(2).length} bits, past the 64-bit range a number holds here`,
)

// the two ends of the 64-bit range, read and written back unchanged on every native backend: 2^63 - 1, and -2^63
// (major 1 carries -1 - value, the same digits)
const EDGES: string[] = ['1c', '3c'].map(tag =>
  compact(frame('01', `${tag} ${leb(2n ** 63n - 1n - 28n)}`)),
)

// the calls each backend makes after the round trips, and what each must print
type Edge = {
  call: 'refusal' | 'recode'
  hex: string
  want: string
  name: string
}

const EDGE_CALLS: Edge[] = [
  ...REFUSALS.map((one, at) => ({
    call: 'refusal' as const,
    hex: compact(one.stream),
    want: REFUSED[at]!,
    name: `refuses ${one.stream.slice(12, 40)}... as the TypeScript port does`,
  })),
  ...WIDE.map((one, at) => ({
    call: 'refusal' as const,
    hex: compact(frame('01', one.body)),
    want: WIDE_WANT[at]!,
    name: `refuses the ${one.value.toString(2).length}-bit integer ${one.body.slice(0, 14)}... as too-large`,
  })),
  ...EDGES.map(hex => ({
    call: 'recode' as const,
    hex,
    want: hex,
    name: `reads and writes back ${hex.slice(8, 30)}..., an end of the 64-bit range`,
  })),
]

function frontEnd(env: 'rust' | 'swift' | 'kotlin'): Program {
  const { sources, scope } = collectModules(
    { file: 'main.tree', text: ENTRY },
    withNativeEnv(env, resolver),
  )
  const program: Program = []

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(
        `parse failed: ${unit.file}: ${parsed.diagnostics.map(d => d.message).join(', ')}`,
      )
    }

    const built = mill(expandTemplates(parsed.tree), unit.file)

    if (!built.ok) {
      throw new Error(
        `mill failed: ${unit.file}: ${built.diagnostics.map(d => d.message).join(', ')}`,
      )
    }

    stampModule(built.program, unit.file)
    program.push(...built.program)
  }

  bindModules(program, scope, 'main.tree')
  resolveNames(program, 'main.tree')

  const errors = check(program, 'main.tree').filter(
    d => d.severity !== 'warning',
  )

  if (errors.length) {
    throw new Error(
      `check failed: ${errors
        .slice(0, 5)
        .map(d => d.message)
        .join(' | ')}`,
    )
  }

  resolveAsync(program)

  return simplify(program, new Set(ROOTS))
}

// each output: the hex of every input, then the hex of every reference decoded and encoded again
function compare(env: string, output: string): void {
  const got = output.split(SEP)

  INPUTS.forEach((_, at) => {
    ok(
      `${env}: input ${at} encodes to the reference's bytes`,
      got[at] === WANT[at],
      `\n      got  ${got[at]}\n      want ${WANT[at]}`,
    )
    ok(
      `${env}: input ${at} decodes and encodes back unchanged`,
      got[INPUTS.length + at] === WANT[at],
      `\n      got  ${got[INPUTS.length + at]}\n      want ${WANT[at]}`,
    )
  })

  EDGE_CALLS.forEach((edge, at) => {
    const one = got[INPUTS.length * 2 + at]

    ok(
      `${env}: ${edge.name}`,
      one === edge.want,
      `\n      got  ${one}\n      want ${edge.want}`,
    )
  })
}

// the TypeScript port refuses each stream as named, so the native comparison holds the intended refusal
REFUSALS.forEach((one, at) => {
  ok(
    `typescript: refuses ${one.stream.slice(12, 40)}... as ${one.name}`,
    REFUSED[at]!.startsWith(`${one.name} @`),
    REFUSED[at],
  )
})

// and reads every wide integer (the nearest double), which is why a native refusal of one is the model's limit
WIDE.forEach(one => {
  ok(
    `typescript: reads the ${one.value.toString(2).length}-bit integer`,
    portRefusal(frame('01', one.body)) === 'accepted',
    portRefusal(frame('01', one.body)),
  )
})

// the native calls for the edges, one per backend's spelling
function edgeCalls(
  spell: (task: 'refusal' | 'recode', hex: string) => string,
): string[] {
  return EDGE_CALLS.map(edge => spell(edge.call, edge.hex))
}

const dir = runDir('term-host-code-native-')
const texts = [...INPUTS, ...WANT]
const CARGO_ENV = {
  ...process.env,
  CARGO_TARGET_DIR: join(tmpdir(), 'term-host-native-target'),
}

function runRust(): void {
  if (!have('cargo')) {
    return skipped(
      'rust: the codec builds and agrees',
      'cargo not installed',
    )
  }

  const program = frontEnd('rust')
  const out = join(dir, 'rust')

  mkdirSync(join(out, 'src'), { recursive: true })
  writeFileSync(
    join(out, 'Cargo.toml'),
    '[package]\nname = "host_code_native"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde_json = "1"\nregex = "1"\nbase64 = "0.22"\nhex = "0.4"\nsha2 = "0.10"\nuuid = { version = "1", features = ["v4"] }\nrand = "0.8"\n',
  )

  const calls = [
    ...INPUTS.map(
      input =>
        `print!("{}\\u{1e}", code_hex(${JSON.stringify(input)}.to_string()).unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) }));`,
    ),
    ...WANT.map(
      hex =>
        `print!("{}\\u{1e}", recode_hex(${JSON.stringify(hex)}.to_string()).unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) }));`,
    ),
    // refusal-of catches every raise, so Rust gives it no Result
    ...edgeCalls((task, hex) =>
      task === 'refusal'
        ? `print!("{}\\u{1e}", refusal_of(${JSON.stringify(hex)}.to_string()));`
        : `print!("{}\\u{1e}", recode_hex(${JSON.stringify(hex)}.to_string()).unwrap_or_else(|e| { format!("raised {}", e) }));`,
    ),
  ]

  writeFileSync(
    join(out, 'src/main.rs'),
    `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(program)}\nfn main() {\n${calls.join('\n')}\n}\n`,
  )

  try {
    const output = execFileSync('cargo', ['run', '--quiet'], {
      cwd: out,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: CARGO_ENV,
    }).toString()

    ok('rust: the codec builds', true)
    compare('rust', output)
  } catch (error) {
    ok(
      'rust: the codec builds and runs',
      false,
      String((error as { stderr?: Buffer }).stderr ?? error),
    )
  }
}

function runSwift(): void {
  if (!have('swiftc')) {
    return skipped(
      'swift: the codec builds and agrees',
      'swiftc not installed',
    )
  }

  const program = frontEnd('swift')
  const out = join(dir, 'swift')
  const file = join(out, 'main.swift')

  mkdirSync(out, { recursive: true })

  const calls = [
    ...INPUTS.map(
      input =>
        `print(try! codeHex(input: ${JSON.stringify(input)}), terminator: "\\u{1e}")`,
    ),
    ...WANT.map(
      hex =>
        `print(try! recodeHex(input: ${JSON.stringify(hex)}), terminator: "\\u{1e}")`,
    ),
    ...edgeCalls(
      (task, hex) =>
        `do { print(try ${task === 'refusal' ? 'refusalOf' : 'recodeHex'}(input: ${JSON.stringify(hex)}), terminator: "\\u{1e}") } catch { print("raised \\(error)", terminator: "\\u{1e}") }`,
    ),
  ]

  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(program)}\n${calls.join('\n')}\n`,
  )

  try {
    execFileSync('swiftc', ['-o', join(out, 'main'), file], {
      stdio: 'pipe',
    })
    ok('swift: the codec builds', true)
    compare('swift', execFileSync(join(out, 'main')).toString())
  } catch (error) {
    ok(
      'swift: the codec builds and runs',
      false,
      String((error as { stderr?: Buffer }).stderr ?? error),
    )
  }
}

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    return skipped(
      'kotlin: the codec builds and agrees',
      'kotlinc/java not installed',
    )
  }

  const program = frontEnd('kotlin')
  const out = join(dir, 'kotlin')
  const file = join(out, 'main.kt')

  mkdirSync(out, { recursive: true })

  const calls = [
    ...INPUTS.map(input => `codeHex(${JSON.stringify(input)})`),
    ...WANT.map(hex => `recodeHex(${JSON.stringify(hex)})`),
    ...edgeCalls(
      (task, hex) =>
        `(try { ${task === 'refusal' ? 'refusalOf' : 'recodeHex'}(${JSON.stringify(hex)}) } catch (e: Throwable) { "raised " + e })`,
    ),
  ]

  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(program)}\nfun main() { for (out in listOf(${calls.join(', ')})) { print(out + "\\u001e") } }\n`,
    ),
  )

  try {
    execFileSync(
      'kotlinc',
      [file, '-include-runtime', '-d', join(out, 'main.jar')],
      { stdio: 'pipe' },
    )
    ok('kotlin: the codec builds', true)
    compare(
      'kotlin',
      execFileSync('java', ['-jar', join(out, 'main.jar')]).toString(),
    )
  } catch (error) {
    ok(
      'kotlin: the codec builds and runs',
      false,
      String((error as { stderr?: Buffer }).stderr ?? error),
    )
  }
}

const only = process.env.HN_ONLY ?? ''

for (const [env, run] of [
  ['rust', runRust],
  ['swift', runSwift],
  ['kotlin', runKotlin],
] as const) {
  if (!only || only === env) {
    try {
      run()
    } catch (error) {
      ok(`${env}: the front end`, false, String(error))
    }
  }
}

console.log(
  `\nhost-code-native: ${pass} pass, ${fail} fail, ${skip} skipped`,
)

if (fail > 0) {
  process.exit(1)
}
