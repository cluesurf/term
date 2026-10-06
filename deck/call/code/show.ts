// `term show [mark]`: the toolchain's version and platform, or the project's version. Each is the answer itself, so it
// is data on stdout (`printData`), and `--back json` prints it as one JSON object instead of the block.
//
// Four things a guide found on 2026-10-04 (guides: commands/show), each held by test/call/exit-codes.ts:
//
// - `term show mark` reads the NEAREST deck.tree, this folder or a parent, the way every other command finds its
//   project. From a project's `code/` folder it said there was no deck.tree.
// - a deck.tree that is there and cannot be read says so, with the reader's message. It said there was none.
// - `--back json` was accepted and changed nothing.
// - an argument it does not know is refused, exit 2. It printed the toolchain as though none had been given.

import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { infoText } from '@term/make/code/show'
import { showKink } from '@term/call/code/kink'
import { showContext } from '@term/call/code/context'
import { closeRun, field, location, openRun, printData, report, showPath } from '@term/call/code/output'

export async function callShow(input: {
  root: string
  what?: string
  // the object of `kink` (a diagnostic's name or code) and of `name` (a name in the project)
  name?: string
  budget?: number
  back?: string
  version: string
}): Promise<void> {
  const json = input.back === 'json'

  if (input.what === undefined) {
    printData(
      json
        ? `${JSON.stringify({ term: input.version, platform: os.platform(), arch: os.arch(), node: process.version, home: os.homedir() })}\n`
        : infoText(input.version),
    )

    return
  }

  if (input.what === 'tools') {
    showTools(json)

    return
  }

  // what a diagnostic means, by the name or code a run printed (call/code/kink.ts)
  if (input.what === 'kink') {
    showKink({ root: input.root, query: input.name, json })

    return
  }

  // one name of the project with what a reader needs around it, sized to a budget (call/code/context.ts)
  if (input.what === 'name') {
    await showContext({ root: input.root, query: input.name, json, budget: input.budget })

    return
  }

  if (input.what !== 'mark' && input.what !== 'code') {
    openRun({ verb: 'show', root: input.root })
    report({ glyph: 'failed', kind: 'problem', subject: `There is nothing named ${input.what} to show` })
    closeRun({ verdict: 'Nothing shown', next: 'term show, term show mark, term show tools, term show kink or term show name', failure: 'usage' })

    return
  }

  const manifest = nearestManifest(input.root)

  if (!manifest) {
    openRun({ verb: 'show', root: input.root })
    report({ glyph: 'failed', kind: 'problem', subject: 'There is no deck.tree here or above', fields: [field('looked', showPath(input.root))] })
    closeRun({ verdict: 'No version to show', next: 'term wake, to make a project here' })

    return
  }

  const { loadManifest, showCode } = await import('@cluesurf/deck.tree')

  try {
    const read = await loadManifest({ dir: path.dirname(manifest) })
    const mark = showCode(read.mark)

    printData(json ? `${JSON.stringify({ mark })}\n` : `${mark}\n`)
  } catch (error) {
    openRun({ verb: 'show', root: input.root })
    report({
      glyph: 'failed',
      kind: 'problem',
      subject: 'The deck.tree could not be read',
      fields: [location(showPath(manifest))],
      message: [error instanceof Error ? error.message : String(error)],
    })
    closeRun({ verdict: 'No version to show' })
  }
}

// The toolchains each backend calls, and the version each answers with, or `not found`. A missing `cargo` or
// `swiftc` was first seen when a `--target` build called it (guides: basics/install, 2026-10-04). Asks each one for
// its version, so it reports what is on the PATH now, and installs nothing
const TOOLS: { backend: string; name: string; args: string[] }[] = [
  { backend: 'rust', name: 'cargo', args: ['--version'] },
  { backend: 'rust', name: 'rustc', args: ['--version'] },
  { backend: 'swift', name: 'swiftc', args: ['--version'] },
  { backend: 'kotlin', name: 'kotlinc', args: ['-version'] },
  { backend: 'kotlin', name: 'java', args: ['-version'] },
]

// one tool's version, or undefined when it is not on the PATH or will not answer. `term make --target` asks the same
// question before it builds anything (call/code/cask.ts)
export function toolVersion(name: string): string | undefined {
  const tool = TOOLS.find(one => one.name === name)
  const run = spawnSync(name, tool?.args ?? ['--version'], { encoding: 'utf8', timeout: 30_000 })
  // the first line that names a version, from stdout or stderr: `java -version` and `kotlinc -version` print on
  // stderr
  const said = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
    .split('\n')
    .map(line => line.trim())
    .find(line => /\d+\.\d+/.test(line))
    ?.replace(/^info:\s*/, '')

  return run.error || run.status !== 0 ? undefined : (said ?? 'found')
}

function showTools(json: boolean): void {
  const found = TOOLS.map(tool => ({ ...tool, version: toolVersion(tool.name) }))

  if (json) {
    printData(`${JSON.stringify(found.map(({ backend, name, version }) => ({ backend, tool: name, version: version ?? null })))}\n`)

    return
  }

  const width = Math.max(...TOOLS.map(tool => tool.name.length))

  printData(
    found
      .map(tool => `${tool.backend.padEnd(7)} ${tool.name.padEnd(width)}  ${tool.version ?? 'not found'}\n`)
      .join(''),
  )
}

// the deck.tree in `from` or the nearest folder above it
function nearestManifest(from: string): string | undefined {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'deck.tree')

    if (fs.existsSync(file)) {
      return file
    }

    if (path.dirname(dir) === dir) {
      return undefined
    }
  }
}
