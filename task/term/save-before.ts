// Save the original of a module before a port replaces it, and never overwrite a reference copy
// (term-self-host-001-0012, traps.md T035: the old tmp/save-before.sh wrote with `>` and destroyed resolve-before.ts).
//
//   tsx task/term/save-before.ts <deck/make/code/path.ts> <name> [--at <rev>] [--deck <d>] [--working]
//
// Reads the file as git holds it at HEAD (or `rev`), and writes it to <term>/tmp/retired/<d>/<name> (`d` defaults to
// make). `--working` takes the working copy instead of git's. The write uses the `wx` flag, so an existing file, a race
// and a symbolic link at the target all refuse. Exit 0 saved, 2 refused or bad usage, 1 unreadable source.
//
// The path is relative to the Term package, the way the old script's was (`deck/make/code/compile/host.ts`).

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { TERM_ROOT } from './root'

// absolute, so the command works from any directory
const TERM = TERM_ROOT
const RETIRED = join(TERM, 'tmp/retired')

const positional: string[] = []
const options = new Map<string, string>()
let working = false
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === '--working') {
    working = true
  } else if (arg === '--at' || arg === '--deck') {
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) {
      usage(`${arg} needs a value`)
    }
    options.set(arg, value!)
    i++
  } else if (arg.startsWith('--')) {
    usage(`unknown flag ${arg}`)
  } else {
    positional.push(arg)
  }
}

const [source, name] = positional
if (source === undefined || name === undefined || positional.length !== 2) {
  usage('needs a path and a name')
}
const rev = options.get('--at') ?? 'HEAD'
const deck = options.get('--deck') ?? 'make'

if (working && options.has('--at')) {
  usage('--working and --at are exclusive')
}

const dir = resolve(RETIRED, deck)
const target = resolve(dir, name!)
// a name or deck that climbs out of tmp/retired is refused, never written
const inside = relative(RETIRED, target)
if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || isAbsolute(name!) || isAbsolute(deck)) {
  usage(`${name} (deck ${deck}) leaves ${RETIRED}`)
}

let bytes: Buffer
try {
  if (working) {
    bytes = readFileSync(resolve(TERM, source!))
  } else {
    bytes = execFileSync('git', ['-C', TERM, 'show', `${rev}:${source}`], {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`unreadable: ${working ? 'working copy' : rev} ${source}: ${message.split('\n')[0]}`)
  if (!working) {
    console.error('an untracked file has no git copy: use --working')
  }
  process.exit(1)
}

try {
  mkdirSync(dirname(target), { recursive: true })
  // wx: create, fail if anything is there. The only way into tmp/retired.
  writeFileSync(target, bytes, { flag: 'wx' })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
    console.log(`refused: ${target} exists`)
    process.exit(2)
  }
  throw error
}

console.log(`saved: ${target} ${bytes.length}`)

function usage(why: string): never {
  console.error(`${why}\nusage: save-before.ts <deck/make/code/path.ts> <name> [--at <rev>] [--deck <d>] [--working]`)
  process.exit(2)
}
