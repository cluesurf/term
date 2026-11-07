// THE RELEASED TOOLCHAIN, RUN THE WAY A PERSON RUNS IT (zone-0144). Every other suite runs inside this checkout, where
// the stdlib has its manifest, every package is a sibling and nothing climbs out of the root, so Term 2.9.0 passed
// them all and still could not test, unit-build or boot any project outside it. This suite:
//
//   1. takes this platform's release payload as `pnpm run release --dry` wrote it, or one given with --from, or with
//      --build builds it (task/release.ts --dry --platform <this> --out <temp>), payload gate and all
//   2. installs it into a temporary HOME, under .base/@term/code/code/<version>/term, as the loader does
//   3. in a project in the system temporary folder, outside any checkout, runs the installed `term`: make (its stdlib
//      units must be named `_term_base_...`), test, boot from the project, boot from another folder, boot --out and
//      the bundle run (its -v, --help, an unknown command, and a report through @term/call/item), and the same project
//      with link/@term/base linked into this checkout
//   4. reads every file the runs wrote into the project (host/, the --out bundle, not the .base/ cache) for a machine
//      path: the temporary folder, the HOME, the install and this checkout, each also flattened the way a unit name
//      flattens a path (`Users_x_.base__term_...`), and every command's output for this checkout's path
//   5. checks the payload carries term/host/compile.mjs, stage0 of the fixpoint chain `pnpm term:boot` fetches
//      (decision 126 of change 001-finish-self-host), and that it exports the seven names port-build loads from stage0
//      (task/stage0.ts STAGE0_SOURCES)
//
//   npx tsx task/term/release-user.ts                    check the payload `pnpm run release --dry` wrote, at
//                                                        tmp/release/<version>/term-<platform>.tar.gz (says so in one
//                                                        line and exits 1 when there is none)
//   npx tsx task/term/release-user.ts --build            build this platform's payload here and check it
//   npx tsx task/term/release-user.ts --from <x>       check a payload already built (a .tar.gz, or a folder holding
//                                                        term/, such as an install's code/<version>)
//   npx tsx task/term/release-user.ts --keep             keep the temporary folder and print its path
//
// Prints `release-user: N pass, M fail`, exits 1 on a failure. Skipped on Windows (the launcher is bin\term.cmd).

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TERM_ROOT } from './root'

const TERM = realpathSync(TERM_ROOT)

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info === '' ? '' : `  ${info}`}`)
  }
}

function flagValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag)

  return at < 0 ? undefined : process.argv[at + 1]
}

// the payload name of this machine, as task/release.ts PLATFORMS names it
function platformName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

  return `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`
}

// the last lines of a run's output, for a failure's note
function tail(text: string, lines = 4): string {
  return text.trim().split('\n').slice(-lines).join(' | ').slice(0, 600)
}

type Ran = { status: number | null; text: string }

// every run but the --build one stops at 180 seconds, so the nine `term` runs fit inside the board's 1800 together. A
// stopped run is SIGKILLed and reads as a failure, never a hang
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 180): Ran {
  const ran = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: timeout * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 })

  return { status: ran.status, text: `${ran.stdout ?? ''}${ran.stderr ?? ''}${ran.error ? `\n${ran.error.message}` : ''}` }
}

// every file under a folder, dotfiles included, a symlink not followed, `.base` (the build cache, never published)
// and node_modules left out
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }

  const found: string[] = []

  for (const name of readdirSync(dir)) {
    if (name === '.base' || name === 'node_modules') {
      continue
    }

    const at = join(dir, name)
    const stat = lstatSync(at)

    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      found.push(...filesUnder(at))
    } else {
      found.push(at)
    }
  }

  return found
}

// a path as it may appear in output: itself, and flattened the way a unit's name flattens one (every character but a
// letter, digit or dot to `_`, the leading separator dropped)
function needlesOf(paths: string[]): string[] {
  const needles = new Set<string>()

  for (const one of paths) {
    if (one.length < 6) {
      continue
    }

    needles.add(one)
    needles.add(one.slice(1).replace(/[^A-Za-z0-9.]/g, '_'))
  }

  return [...needles]
}

// the machine paths found in the files under these folders, each `file: needle`
function machinePaths(dirs: string[], needles: string[], base: string): string[] {
  const hits: string[] = []

  for (const dir of dirs) {
    for (const file of filesUnder(dir)) {
      const name = relative(base, file)
      const text = readFileSync(file, 'latin1')

      for (const needle of needles) {
        if (text.includes(needle) || name.includes(needle)) {
          hits.push(`${name}: ${needle}`)
        }
      }

      // a unit named by a path that climbs out of the project
      if (/(^|\/)\.unit\/\.\./.test(name) || text.includes('.unit/.._')) {
        hits.push(`${name}: a unit named by a climbing path`)
      }
    }
  }

  return hits
}

// the environment of a person's shell: nothing of this checkout's (TERM_* variables, NODE_PATH, NODE_OPTIONS), HOME
// the temporary one
function personEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('TERM_') || key.startsWith('NODE_') || key.startsWith('npm_') || key === 'INIT_CWD' || key === 'PNPM_SCRIPT_SRC_DIR') {
      continue
    }

    env[key] = value
  }

  env.HOME = home
  env.USERPROFILE = home

  return env
}

const PROJECT_FILES: Record<string, string> = {
  'deck.tree': 'deck @probe/user\n  mark <0.0.1>\n  test ./test\n',
  'code/helper.tree': 'load @term/base/text\n  find trim\n\ntask answer\n  take who, like text\n  like number\n  save said, trim(who)\n  back 3\n',
  // `hello` reports through the printer a program loads from the payload, @term/call/item (item term-self-host-001-0983)
  'code/base.tree':
    "load ./helper\n  find answer\n\nload @term/call/item\n  find opening\n  find item\n  find field\n  find closing\n  find open-run\n  find report\n  find close-run\n\n# Answer with the helper's number\nhook say\n  take who\n  task answer\n\ntask hello\n  like number\n  open-run(make(opening, bind(verb, <hello>), bind(subject, <the project>), bind(tool, <user 0.0.1>)))\n  save hint, make(field, bind(key, <next>), bind(value, <user say>))\n  save hints, make list\n  hints/push hint\n  report(make(item, bind(glyph, <done>), bind(verb, <hello>), bind(subject, <said hello>), bind(fields, hints)))\n  back close-run(make(closing, bind(verdict, <Said hello>), bind(next, <>), bind(failure, <>)))\n\n# Say hello through the printer\nhook hello\n  task hello\n",
  'test/a.tree': 'load @term/base/text\n  find trim\n\ntest trims\n  want hold\n    call is-equal\n      call trim\n        text < a >\n      text <a>\n',
}

function writeProject(dir: string): void {
  for (const [name, text] of Object.entries(PROJECT_FILES)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
}

// the payload `pnpm run release --dry` writes for this machine, the file test/call/self-release.ts reads
function payloadFile(): string {
  const version = (JSON.parse(readFileSync(join(TERM, 'package.json'), 'utf8')) as { version: string }).version

  return join(TERM, 'tmp', 'release', version, `term-${platformName()}.tar.gz`)
}

// the payload: the one `pnpm run release --dry` wrote, the one --from names (as a folder holding term/), or with
// --build one built here
function payload(work: string): string | undefined {
  const from = flagValue('--from')
  const unpacked = join(work, 'payload')

  mkdirSync(unpacked, { recursive: true })

  if (from !== undefined) {
    const given = resolve(from)

    if (given.endsWith('.tar.gz')) {
      const untar = run('tar', ['-xzf', given, '-C', unpacked], work, process.env)
      ok('the given payload unpacks', untar.status === 0, tail(untar.text))
    } else {
      cpSync(join(given, 'term'), join(unpacked, 'term'), { recursive: true, verbatimSymlinks: true })
    }

    return existsSync(join(unpacked, 'term', 'host', 'line.js')) ? unpacked : undefined
  }

  if (!process.argv.includes('--build')) {
    const tarball = payloadFile()
    const untar = run('tar', ['-xzf', tarball, '-C', unpacked], work, process.env)
    ok('the release payload unpacks', untar.status === 0, tail(untar.text))

    return existsSync(join(unpacked, 'term', 'host', 'line.js')) ? unpacked : undefined
  }

  const out = join(work, 'release')
  const built = run('npx', ['tsx', 'task/release.ts', '--dry', '--platform', platformName(), '--out', out], TERM, process.env, 1800)
  const tarball = join(out, `term-${platformName()}.tar.gz`)
  // a refused build quotes the payload gate's own lines, which name the leak, else its last lines
  const said = built.text.split('\n').filter(line => /parent-name|machine|absolute|climb|refused|rror/.test(line))
  ok('the release payload builds (task/release.ts --dry --platform)', built.status === 0 && existsSync(tarball), said.length > 0 ? said.slice(0, 8).join(' | ').slice(0, 900) : tail(built.text, 8))

  if (!existsSync(tarball)) {
    return undefined
  }

  const untar = run('tar', ['-xzf', tarball, '-C', unpacked], work, process.env)
  ok('the payload unpacks', untar.status === 0, tail(untar.text))

  return unpacked
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.log('release-user: 0 pass, 0 fail (skipped on Windows)')

    return
  }

  // the payload is built by `pnpm run release --dry`, never here by default: building it takes as long as the board
  // gives this whole suite, so a missing one is said in one line at once
  if (flagValue('--from') === undefined && !process.argv.includes('--build') && !existsSync(payloadFile())) {
    console.log(`release-user: no payload at ${payloadFile()}; run \`pnpm run release --dry\` first`)
    process.exitCode = 1

    return
  }

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'release-user-')))

  if (!relative(TERM, work).startsWith('..')) {
    console.log(`release-user: 0 pass, 1 fail (the temporary folder ${work} is inside the checkout, so nothing here is outside it)`)
    process.exitCode = 1

    return
  }

  // the names port-build loads from stage0, read from task/stage0.ts itself, by a dynamic import: task/term runs as
  // CommonJS, and stage0.ts is an ES module with a top-level await (trap T-0170)
  const { STAGE0_SOURCES } = (await import('../stage0')) as { STAGE0_SOURCES: Record<string, string[]> }
  const stage0Names = Object.values(STAGE0_SOURCES).flat().sort()

  try {
    check(work, stage0Names)
  } finally {
    if (process.argv.includes('--keep')) {
      console.log(`kept ${work}`)
    } else {
      rmSync(work, { recursive: true, force: true })
    }
  }

  console.log(`\nrelease-user: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

function check(work: string, stage0Names: string[]): void {
  const unpacked = payload(work)

  if (unpacked === undefined) {
    ok('a payload to install', false, 'none built or given')

    return
  }

  ok('the payload carries LICENSE and NOTICE', existsSync(join(unpacked, 'term', 'LICENSE')) && existsSync(join(unpacked, 'term', 'NOTICE')))

  // 0. stage0 of the fixpoint chain (decision 126): term/host/compile.mjs, loaded by a plain node outside any checkout,
  // exporting every name port-build calls on a stage0
  const compile = join(unpacked, 'term', 'host', 'compile.mjs')
  ok('the payload carries term/host/compile.mjs, stage0 for term:boot', existsSync(compile))

  if (existsSync(compile)) {
    const listing = `const m = await import(${JSON.stringify(pathToFileURL(compile).href)}); console.log(Object.keys(m).sort().join(' '))`
    const listed = run(process.execPath, ['--input-type=module', '-e', listing], work, personEnv(join(work, 'stage0-home')))
    const exported = listed.text.trim().split('\n').at(-1)?.split(' ') ?? []
    const missing = stage0Names.filter(name => !exported.includes(name))
    ok(
      `compile.mjs exports the ${stage0Names.length} names port-build loads from stage0`,
      listed.status === 0 && stage0Names.length === 7 && missing.length === 0,
      `exit ${listed.status}, ${stage0Names.length} names, missing ${missing.join(' ') || 'none'}: ${tail(listed.text)}`,
    )
  }

  const version = (JSON.parse(readFileSync(join(unpacked, 'term', 'package.json'), 'utf8')) as { version: string }).version
  const home = join(work, 'home')
  const install = join(home, '.base', '@term', 'code', 'code', version)

  mkdirSync(install, { recursive: true })
  cpSync(join(unpacked, 'term'), join(install, 'term'), { recursive: true, verbatimSymlinks: true })

  const term = join(install, 'term', 'bin', 'term')
  const env = personEnv(home)
  const project = join(work, 'project')
  // another folder at ANOTHER DEPTH than the project: a unit named by a path from its build's root is right at one
  // depth and unresolvable at any other (2.9.0 stored them under one name for every root)
  const elsewhere = join(work, 'else', 'where', 'deeper')
  const outputs: { name: string; text: string }[] = []
  const say = (name: string, args: string[], cwd: string): Ran => {
    const ran = run(term, args, cwd, env)
    outputs.push({ name, text: ran.text })

    return ran
  }

  writeProject(project)
  mkdirSync(elsewhere, { recursive: true })

  // 1. term make: exit 0, the stdlib's units named by their deck, never by a path from the project
  const made = say('make', ['make'], project)
  ok('term make builds the project', made.status === 0, tail(made.text))
  const units = existsSync(join(project, 'host', '.unit')) ? readdirSync(join(project, 'host', '.unit')) : []
  ok('term make writes the stdlib units it imports, named _term_base_...', units.includes('_term_base_code_text.ts'), units.slice(0, 6).join(' '))
  ok('no unit is named by a path out of the project', !units.some(name => name.startsWith('.')), units.filter(name => name.startsWith('.')).slice(0, 2).join(' '))

  // 2. term test
  const tested = say('test', ['test'], project)
  ok('term test runs the project test', tested.status === 0 && /1 test\b.*1 passed/.test(tested.text), tail(tested.text))

  // 3. term boot, from the project and from another folder
  const here = say('boot here', ['boot', 'code/base.tree', '--', 'say', '--who', 'you'], project)
  ok('term boot from the project runs the program', here.status === 3, `exit ${here.status}: ${tail(here.text)}`)
  const away = say('boot elsewhere', ['boot', join(project, 'code', 'base.tree'), '--', 'say', '--who', 'you'], elsewhere)
  ok('term boot from another folder runs the program', away.status === 3, `exit ${away.status}: ${tail(away.text)}`)
  const out = join(project, 'out')
  const booted = say('boot --out', ['boot', join(project, 'code', 'base.tree'), '--out', out], elsewhere)
  ok('term boot --out writes the bundle', booted.status === 0 && existsSync(join(out, 'run.mjs')), tail(booted.text))
  const bundled = run('node', [join(out, 'run.mjs'), 'say', '--who', 'you'], elsewhere, env)
  ok('the --out bundle runs', bundled.status === 3, `exit ${bundled.status}: ${tail(bundled.text)}`)

  // the booted program answers its command line as term does (zone decision 002): its version from its manifest's
  // mark, its help in term's layout, an unknown command refused in term's shape, and its own report through the
  // printer the payload ships (@term/call/item)
  const mark = run('node', [join(out, 'run.mjs'), '-v'], elsewhere, env)
  ok('the booted program answers -v with its mark', mark.status === 0 && mark.text.trim() === '0.0.1', `exit ${mark.status}: ${tail(mark.text)}`)
  const help = run('node', [join(out, 'run.mjs'), '--help'], elsewhere, env)
  ok("the booted program's --help is term's layout", help.status === 0 && /^Commands:$/m.test(help.text) && /^ {2}user say\b/m.test(help.text), tail(help.text, 8))
  const refused = run('node', [join(out, 'run.mjs'), 'nope'], elsewhere, env)
  ok(
    'the booted program refuses an unknown command in term\'s shape, exit 2',
    refused.status === 2 && /✗ user There is no command named nope/.test(refused.text) && /The command line was not understood/.test(refused.text) && /next user, for the list of commands/.test(refused.text),
    `exit ${refused.status}: ${tail(refused.text, 6)}`,
  )
  const hello = run('node', [join(out, 'run.mjs'), 'hello'], elsewhere, env)
  ok(
    'the booted program reports through @term/call/item',
    hello.status === 0 && /✓ hello said hello/.test(hello.text) && /next user say/.test(hello.text) && /Said hello/.test(hello.text),
    `exit ${hello.status}: ${tail(hello.text, 6)}`,
  )

  // 4. the same project with link/@term/base linked into a checkout, as a person with a local Term link has
  const linked = join(work, 'linked')
  writeProject(linked)
  mkdirSync(join(linked, 'link', '@term'), { recursive: true })
  symlinkSync(join(TERM, 'deck', 'base'), join(linked, 'link', '@term', 'base'))
  const linkMade = run(term, ['make'], linked, env)
  ok('term make with link/@term/base', linkMade.status === 0, tail(linkMade.text))
  const linkBoot = run(term, ['boot', join(linked, 'code', 'base.tree'), '--', 'say', '--who', 'you'], elsewhere, env)
  ok('term boot with link/@term/base, from another folder', linkBoot.status === 3, `exit ${linkBoot.status}: ${tail(linkBoot.text)}`)
  const linkTest = run(term, ['test'], linked, env)
  ok('term test with link/@term/base', linkTest.status === 0 && /1 test\b.*1 passed/.test(linkTest.text), tail(linkTest.text))

  // 5. machine paths in what the runs wrote, and this checkout's path in what they printed
  const raw = join(tmpdir())
  const needles = needlesOf([work, home, install, TERM, realpathSync(homedir()), raw])
  const hits = machinePaths([join(project, 'host'), out, join(linked, 'host')], needles, work)
  ok('no machine path in the build output (host/, the --out bundle)', hits.length === 0, `${hits.length}: ${hits.slice(0, 4).join('; ')}`)
  const told = outputs.filter(one => needlesOf([TERM]).some(needle => one.text.includes(needle)))
  ok("no command's output names this checkout", told.length === 0, told.map(one => one.name).join(', '))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
