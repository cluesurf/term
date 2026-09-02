// `term view`: check a document and print what it uses.
//
// One implementation, called by the command line, the save path and the editor, so the three cannot drift on what
// a document is allowed to say. That is the same argument the root CLAUDE.md makes about hand-rolled readers,
// applied to a gate.
//
// Reports by default and writes nothing. `--find` prints the query manifest, which is the `host` dialect, so it
// pipes into `term mold --json` for a route loader that wants it that way. See note/term/view/08-package-and-cli.md.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import {
  checkView,
  viewManifest,
  type Seed,
  type ViewFile,
  type ViewNode,
} from '@term/make/code/compile/view'

export type ViewCall = {
  root: string
  path?: string
  find?: boolean
  back?: string
}

type Look = {
  file: string
  view: string[]
  call: string[]
  find: string[]
  tree: number
  load: string[]
  node: number
  deep: number
  manifest: string
}

export async function callView(input: ViewCall): Promise<void> {
  // `resolve`, not `join`: join APPENDS an absolute path to the root (join('/a', '/b') is '/a/b'), so
  // `term view /tmp/x/guide.tree` looked for `<project>/tmp/x/guide.tree` and reported the file the caller
  // could see with their own eyes as `no such path`. resolve restarts at an absolute segment, which is what a
  // path argument means. Found by word.surf's guide save gate, the first caller to hand this verb an absolute
  // temp file.
  const target = input.path ? resolve(input.root, input.path) : input.root

  if (!existsSync(target)) {
    console.error(`no such path: ${input.path ?? '.'}`)
    process.exit(2)
  }

  const files = statSync(target).isDirectory() ? walk(target) : [target]

  if (files.length === 0) {
    console.log('no .tree files here')

    return
  }

  const looks: Look[] = []

  let failed = 0

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const name = relative(input.root, file) || file

    // the one gate: the same call the compiler and a save path make, so the three cannot drift
    const read = checkView({ file, text })

    if (!read.ok) {
      failed++
      report(name, read.diagnostics)
      continue
    }

    looks.push(look(name, read.file))
  }

  if (input.find) {
    for (const one of looks) {
      console.log(one.manifest)
    }
  } else if (input.back === 'json') {
    console.log(
      JSON.stringify(
        looks.map(({ manifest, ...rest }) => rest),
        null,
        2,
      ),
    )
  } else {
    for (const one of looks) {
      say(one)
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} document${failed === 1 ? '' : 's'} did not read`)
    process.exit(1)
  }
}

function look(file: string, read: ViewFile): Look {
  // Built from the FORMS, never by regexing the manifest. Reading a serialized shape back with a pattern is a
  // second reader of one grammar, and it broke the moment the manifest moved to the host dialect's own writer,
  // which lays a short list out inline rather than one item per line.
  const view = new Set<string>()
  const call = new Set<string>()

  let node = 0
  let deep = 0

  const seed = (one: Seed): void => {
    if (one.form !== 'call') {
      return
    }

    if (!one.value.made) {
      call.add(one.value.name)
    }

    for (const arg of [...one.value.slot, ...one.value.bind.map(b => b.bond)]) {
      seed(arg)
    }
  }

  const count = (nodes: ViewNode[], depth: number): void => {
    deep = Math.max(deep, depth)

    for (const one of nodes) {
      node++

      switch (one.form) {
        case 'view':
          view.add(one.value.name)

          for (const bind of one.value.bind) {
            seed(bind.bond)
          }

          count(one.value.node, depth + 1)
          break
        case 'walk':
          seed(one.value.road)

          for (const next of one.value.next) {
            count(next.node, depth + 1)
          }

          break
        case 'fork':
          for (const hook of one.value.hook) {
            if (hook.form === 'test') {
              seed(hook.seed)
            } else {
              count(hook.node, depth + 1)
            }
          }

          break
        default:
          break
      }
    }
  }

  for (const def of read.view) {
    count(def.node, 1)
  }

  return {
    file,
    view: [...view].sort(),
    call: [...call].sort(),
    find: read.find.map(one => one.task),
    tree: read.view.length,
    load: read.load.map(one => one.path),
    node,
    deep,
    manifest: viewManifest(read, file.replace(/\.tree$/, '')),
  }
}

function say(one: Look): void {
  console.log(one.file)

  const row = (name: string, values: string[]): void => {
    if (values.length > 0) {
      console.log(`  ${name.padEnd(7)} ${values.join('  ')}`)
    }
  }

  row('view', one.view)
  row('find', one.find)
  row('call', one.call)
  row('load', one.load)
  console.log(`  ${'node'.padEnd(7)} ${one.node}`)
  console.log(`  ${'deep'.padEnd(7)} ${one.deep}`)
}

function report(file: string, diagnostics: { message: string; span?: unknown }[]): void {
  console.error(file)

  for (const one of diagnostics) {
    const span = one.span as { start?: { line: number; column: number } } | undefined
    const at = span?.start ? `${span.start.line + 1}:${span.start.column + 1}` : '?'

    console.error(`  ${at}  ${one.message}`)
  }
}

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === 'host' || name.startsWith('.')) {
      continue
    }

    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, into)
    } else if (path.endsWith('.tree')) {
      into.push(path)
    }
  }

  return into
}
