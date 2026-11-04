// THE RELEASED TOOLCHAIN, RUN THE WAY A PERSON RUNS IT (zone-0144). Every other suite runs inside this checkout, where
// the stdlib has its manifest, every package is a sibling and nothing climbs out of the root, so Term 2.9.0 passed
// them all and still could not test, unit-build or boot any project outside it. This suite:
//
//   1. builds this platform's release payload (task/release.ts --dry --platform <this> --out <temp>), payload gate
//      and all, or takes one given with --from
//   2. installs it into a temporary HOME, under .base/@term/code/code/<version>/term, as the loader does
//   3. in a project in the system temporary folder, outside any checkout, runs the installed `term`: make (its stdlib
//      units must be named `_term_base_...`), test, boot from the project, boot from another folder, boot --out and
//      the bundle run, and the same project with link/@term/base linked into this checkout
//   4. reads every file the runs wrote into the project (host/, the --out bundle, not the .base/ cache) for a machine
//      path: the temporary folder, the HOME, the install and this checkout, each also flattened the way a unit name
//      flattens a path (`Users_x_.base__term_...`), and every command's output for this checkout's path
//
//   npx tsx task/term/release-user.ts                    build and check this platform's payload
//   npx tsx task/term/release-user.ts --from <x>         check a payload already built (a .tar.gz, or a folder holding
//                                                        term/, such as an install's code/<version>)
//   npx tsx task/term/release-user.ts --keep             keep the temporary folder and print its path
//
// Prints `release-user: N pass, M fail`, exits 1 on a failure. Skipped on Windows (the launcher is bin\term.cmd).

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
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

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 600): Ran {
  const ran = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: timeout * 1000, maxBuffer: 64 * 1024 * 1024 })

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
  'code/base.tree': "load ./helper\n  find answer\n\n# Answer with the helper's number\nhook say\n  take who\n  task answer\n",
  'test/a.tree': 'load @term/base/text\n  find trim\n\ntest trims\n  want hold\n    call is-equal\n      call trim\n        text < a >\n      text <a>\n',
}

function writeProject(dir: string): void {
  for (const [name, text] of Object.entries(PROJECT_FILES)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
}

// the payload: built here, or the one --from names, as a folder holding term/
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

function main(): void {
  if (process.platform === 'win32') {
    console.log('release-user: 0 pass, 0 fail (skipped on Windows)')

    return
  }

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'release-user-')))

  if (!relative(TERM, work).startsWith('..')) {
    console.log(`release-user: 0 pass, 1 fail (the temporary folder ${work} is inside the checkout, so nothing here is outside it)`)
    process.exitCode = 1

    return
  }

  try {
    check(work)
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

function check(work: string): void {
  const unpacked = payload(work)

  if (unpacked === undefined) {
    ok('a payload to install', false, 'none built or given')

    return
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

main()
