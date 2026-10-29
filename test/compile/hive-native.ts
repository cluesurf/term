// The hive told natively (native-exceptions-0006): the compiler emits `wake_hive` / `wakeHive` per backend from
// the roll, the entry point calls it, and every native raise tells the hive before unwinding — the same funnel
// the TypeScript constructor hook carries. A program wakes its hive (its static exception entry), raises, catches,
// and reads `hive-roll`: the static entry present, and the raise appended with its form as the entry name. Built and
// run on the real toolchains. HV_ONLY=rust (or swift, kotlin) runs one backend.
//
// The wake is the COMPILE'S (term/hive decision 002, seam-0030): the program is a package of its own (`@probe/hive`,
// with a `tell`), compiled by `compile`, and emitted through `emitTarget` with `wake: result.wake`, the path every
// native driver takes, so the groups cannot drift from what the roll holds. It was written here by hand.
// Run: npx tsx test/compile/hive-native.ts

import { runDir } from './run-dir'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { emitTarget } from '@term/make/code/compile/emit-target'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import type { WakeGroup } from '@term/make/code/compile/program-warnings'
import type { RollValue } from '@term/make/code/compile/rolling'
import type { Program } from '@term/make/code/compile/node'

type Env = 'rust' | 'swift' | 'kotlin'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
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

const HERE = dirname(fileURLToPath(import.meta.url))
const TERM = resolvePath(HERE, '..', '..')

const readRuntime = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined

// the exception raised, and a probe that reads the hive after a caught raise: decks woken, exception entries,
// and the last entry's name (the raise the tell appended)
const PROGRAM = `load @term/base/code/exception
  find absence

load @term/base/code/hive
  find hive-roll
  find hive-size
  find hive-entry
  find hive-exceptions
  find hive-tells

load @term/base/code/list
  find size
  find get

form user-absence
  like absence
    bind note, <No such user>
    link key, like text

task find-user
  take key, like text
  like text
  halt user-absence
    bind thing, text <user>
    bind key, read key

task check-hive
  like text
  save before
    call size
      call hive-roll
        text <exception>
  fork
    mark unsafe
    save found
      call find-user
        text <zed>
    send back, read found
  halt take
    take problem
    save decks
      call hive-size
    save entries
      call hive-roll
        text <exception>
    save after
      call size
        read entries
    save last
      call get
        read entries
        call subtract
          read after
          code 1
    send back
      text <decks={{decks}} before={{before}} after={{after}} last={{last/name}}>

task hive-size-of
  like number
  send back
    call hive-size

# the static exception the typed wake put in hive-exceptions: its like and note, read off the record (seam-0003)
task static-roll
  like text
  save all
    call hive-exceptions
  walk list
    read all
    hook next
      take site, name entry
      fork test
        hook test
          call is-equal
            read entry/name
            text <user-absence>
        hook hold
          send back, text <{entry/base/like}: {entry/base/note}>
  send back, text <none>

# the static tell the typed wake put in hive-tells, named as the roll names a tell (its deck and form): its note and the
# first field it shows
task static-tell
  like text
  save all
    call hive-tells
  walk list
    read all
    hook next
      take site, name entry
      fork test
        hook test
          call is-equal
            read entry/name
            text <@probe/hive/user-absence>
        hook hold
          send back, text <{entry/base/note} ({entry/base/link/0})>
  send back, text <none>

# what a customer is told of the exception: the static tell the typed wake carries
tell @probe/hive/user-absence
  note <Who is that?>
  link key
`

const dir = runDir('term-hive-native-')
const only = process.env.HV_ONLY ?? ''

// a package of its own, so the roll names a real deck (`@probe/hive`) and its tell, linking the stdlib
const root = join(dir, 'probe')
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
writeFileSync(
  join(root, 'deck.tree'),
  'deck @probe/hive\n  code <0.0.0>\n',
)
const entry = join(root, 'code/main.tree')
writeFileSync(entry, PROGRAM)

// the program as `term make --emit <env>` makes it: compiled for the env, then emitted through `emitTarget` with the
// compile's own wake, and the groups that wake carried
function built(env: Env): { source: string; wake: WakeGroup[] } {
  const result = compile(
    { file: entry, text: PROGRAM },
    {
      resolve: projectResolver(root, env),
      deckOf: projectDeckOf(),
      env,
    },
  )

  if (!result.ok) {
    throw new Error(
      `compile failed: ${result.diagnostics
        .slice(0, 5)
        .map(d => d.message)
        .join(' | ')}`,
    )
  }

  const source = emitTarget({
    program: result.program as Program,
    typescript: '',
    target: env,
    readRuntime,
    wake: result.wake,
  })

  return { source, wake: result.wake ?? [] }
}

// an entry's name: the entry is a roll value (decision 058), its `name` a text in its pair-values
function nameOf(entry: RollValue): string | undefined {
  if (entry.form !== 'pair-values') return undefined
  const found = entry.pairs.find(pair => pair.key === 'name')

  return found?.value.form === 'text-value'
    ? found.value.value
    : undefined
}

// the compile's wake names this deck, with its exception and its tell in the typed groups
function judgeWake(env: Env, wake: WakeGroup[]): void {
  const own = wake.find(group => group.deck === '@probe/hive')
  ok(
    `${env}: the compile's wake holds the deck, its static exception and its tell`,
    own !== undefined &&
      own.typed.exceptions.some(
        one => nameOf(one) === 'user-absence',
      ) &&
      own.typed.tells.some(
        one => nameOf(one) === '@probe/hive/user-absence',
      ),
    JSON.stringify(
      wake.map(group => ({
        deck: group.deck,
        exceptions: group.typed.exceptions.map(nameOf),
        tells: group.typed.tells.map(nameOf),
      })),
    ),
  )
}

// the deck woken; the static entries before the raise; the raise appended with the exception's form as its name
const WANT = /^decks=\d+ before=(\d+) after=(\d+) last=user-absence$/

// the backends whose wake writes the typed rolls, and what the static exception reads back as there
const TYPED: Env[] = ['rust', 'swift', 'kotlin']
const STATIC = 'absence: No such user'
const TOLD = 'Who is that? (key)'

function judge(
  env: Env,
  run: { status: number | null; stdout: string; stderr: string },
): void {
  const counted = WANT.exec(run.stdout.trim().split('\n')[0] ?? '')
  ok(
    `${env}: the wake chain fills the roll and a native raise tells the hive`,
    run.status === 0 &&
      counted !== null &&
      Number(counted[1]) >= 1 &&
      Number(counted[2]) === Number(counted[1]) + 1,
    `exit ${run.status}: ${(run.stdout + run.stderr).slice(0, 300)}`,
  )

  if (TYPED.includes(env)) {
    ok(
      `${env}: a static exception reads back through hive-exceptions with its like and note`,
      run.stdout.trim().split('\n')[1] === STATIC,
      JSON.stringify(run.stdout),
    )
    ok(
      `${env}: a static tell reads back through hive-tells with its note and fields`,
      run.stdout.trim().split('\n')[2] === TOLD,
      JSON.stringify(run.stdout),
    )
  }
}

const CARGO_TOML = `[package]
name = "term-hive-native"
version = "0.1.0"
edition = "2021"

[dependencies]
regex = "1"
sha2 = "0.10"
md-5 = "0.10"
hmac = "0.12"
base64 = "0.22"
hex = "0.4"
uuid = { version = "1", features = ["v4"] }
rand = "0.8"
chrono = "0.4"
serde_json = "1"
unicode-normalization = "0.1"
unicode-segmentation = "1"
`

function runRust(): void {
  if (!have('cargo')) {
    return skipped('rust: hive', 'cargo not installed')
  }

  const { source, wake } = built('rust')
  judgeWake('rust', wake)
  const proj = join(dir, 'rust')
  mkdirSync(join(proj, 'src'), { recursive: true })
  writeFileSync(join(proj, 'Cargo.toml'), CARGO_TOML)
  writeFileSync(
    join(proj, 'src', 'main.rs'),
    `${source}\nfn main() { wake_hive(); println!("{}", check_hive()); println!("{}", static_roll()); println!("{}", static_tell()); }\n`,
  )
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: join(tmpdir(), 'seed-rust-runtime', 'target'),
  }

  try {
    execFileSync('cargo', ['build', '--quiet'], {
      cwd: proj,
      stdio: 'pipe',
      env,
    })
  } catch (e) {
    ok(
      'rust: the hive program builds',
      false,
      String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 600),
    )

    return
  }

  ok('rust: the hive program builds', true)
  judge(
    'rust',
    spawnSync(
      join(
        tmpdir(),
        'seed-rust-runtime',
        'target',
        'debug',
        'term-hive-native',
      ),
      [],
      { encoding: 'utf8' },
    ),
  )
}

function runSwift(): void {
  if (!have('swiftc')) {
    return skipped('swift: hive', 'swiftc not installed')
  }

  const { source, wake } = built('swift')
  judgeWake('swift', wake)
  const main = join(dir, 'main.swift')
  writeFileSync(
    main,
    `${source}\nwakeHive()\nprint(checkHive())\nprint(staticRoll())\nprint(staticTell())\n`,
  )

  try {
    execFileSync('swiftc', ['-o', join(dir, 'swift-main'), main], {
      stdio: 'pipe',
    })
  } catch (e) {
    ok(
      'swift: the hive program builds',
      false,
      String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 600),
    )

    return
  }

  ok('swift: the hive program builds', true)
  judge(
    'swift',
    spawnSync(join(dir, 'swift-main'), [], { encoding: 'utf8' }),
  )
}

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    return skipped('kotlin: hive', 'kotlinc/java not installed')
  }

  const { source, wake } = built('kotlin')
  judgeWake('kotlin', wake)
  const file = join(dir, 'main.kt')
  writeFileSync(
    file,
    `${source}\nfun main() { wakeHive(); println(checkHive()); println(staticRoll()); println(staticTell()) }\n`,
  )
  const jar = join(dir, 'main.jar')

  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], {
      stdio: 'pipe',
    })
  } catch (e) {
    ok(
      'kotlin: the hive program builds',
      false,
      String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 600),
    )

    return
  }

  ok('kotlin: the hive program builds', true)
  judge(
    'kotlin',
    spawnSync('java', ['-jar', jar], { encoding: 'utf8' }),
  )
}

if (!only || only === 'rust') {
  runRust()
}

if (!only || only === 'swift') {
  runSwift()
}

if (!only || only === 'kotlin') {
  runKotlin()
}

console.log(
  `\nhive-native: ${pass} pass, ${fail} fail, ${skip} skipped`,
)

if (fail > 0) {
  process.exit(1)
}
