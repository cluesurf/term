// `term view`: check a document and print what it uses.
//
// One implementation, called by the command line, the save path and the editor, so the three cannot drift on what
// a document is allowed to say. That is the same argument the root CLAUDE.md makes about hand-rolled readers,
// applied to a gate.
//
// Reports by default and writes nothing. `--find` prints the query manifest, which is the `host` dialect, so it
// pipes into `term mold --json` for a route loader that wants it that way. See note/term/view/08-package-and-cli.md.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkView, viewManifest, type ViewFile } from '@term/make/code/compile/view'

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
  const target = input.path ? join(input.root, input.path) : input.root

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
  const manifest = viewManifest(read, file.replace(/\.tree$/, ''))
  const listOf = (name: string): string[] =>
    [
      ...manifest.matchAll(new RegExp(`(?<=list ${name}\\n)((?:  <[^\\n]*>\\n)+)`, 'g')),
    ]
      .flatMap(match => match[1]!.trim().split('\n'))
      .map(line => line.trim().replace(/^<|>$/g, ''))

  let node = 0
  let deep = 0

  const count = (nodes: readonly { form: string }[], depth: number): void => {
    deep = Math.max(deep, depth)

    for (const one of nodes as ReadonlyArray<Record<string, unknown>>) {
      node++

      const value = one.value as Record<string, unknown> | undefined

      if (one.form === 'zone' && value) {
        count((value.node ?? []) as { form: string }[], depth + 1)
      } else if (one.form === 'walk' && value) {
        for (const next of (value.next ?? []) as { node: { form: string }[] }[]) {
          count(next.node, depth + 1)
        }
      } else if (one.form === 'fork' && value) {
        for (const hook of (value.hook ?? []) as Record<string, unknown>[]) {
          if (hook.form !== 'test') {
            count((hook.node ?? []) as { form: string }[], depth + 1)
          }
        }
      }
    }
  }

  for (const def of read.view) {
    count(def.node, 1)
  }

  return {
    file,
    view: listOf('view'),
    call: listOf('call'),
    find: read.find.map(one => one.task),
    tree: read.view.length,
    load: read.load.map(one => one.path),
    node,
    deep,
    manifest,
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
