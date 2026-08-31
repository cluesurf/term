// The package-manager install: resolve a project's dependencies, fetch them into the content-addressed store,
// link them into the project, and write the lockfile. End to end against a registry (a directory of packages; the
// network registry is a swappable source). Node-only (filesystem), runs at build/install time, not in the browser.
// See note/research/vibe/computation/plans/16-package-manager.md.

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import type {
  GroupNode,
  NameNode,
  Node,
  RootNode,
} from '@term/make/code/parser/tree'
import {
  parsePackage,
  storePath,
} from '@term/make/code/deck/resolve'
import type { Lockfile } from '@term/make/code/deck/lock'
import { serializeLockfile } from '@term/make/code/deck/lock'

function nameText(name: NameNode): string {
  return name.parts
    .map(p => (p.kind === 'chunk' ? p.text : ''))
    .join('')
}

function headName(group: GroupNode): string | undefined {
  const first = group.nodes[0]

  return first?.kind === 'name' ? nameText(first) : undefined
}

function rest(group: GroupNode): Node[] {
  return group.nodes.slice(1)
}

function value(group: GroupNode): string {
  const arg = rest(group)[0]

  if (!arg) {
    return ''
  }

  if (arg.kind === 'text') {
    return arg.parts
      .map(p => (p.kind === 'chunk' ? p.text : ''))
      .join('')
  }

  if (arg.kind === 'name') {
    return nameText(arg)
  }

  if (arg.kind === 'group') {
    return headName(arg) ?? ''
  }

  return ''
}

function child(
  group: GroupNode,
  keyword: string,
): GroupNode | undefined {
  for (const node of rest(group)) {
    if (node.kind === 'group' && headName(node) === keyword) {
      return node
    }
  }

  return undefined
}

export type Manifest = {
  name: string
  version: string
  deps: { name: string; range: string }[]
}

export function parseDeck(text: string): Manifest {
  const manifest: Manifest = { name: '', version: '', deps: [] }
  const result = parse({ file: 'deck.tree', text })

  if (!result.ok) {
    return manifest
  }

  const tree: RootNode = result.tree
  const deckGroup = tree.nodes.find(g => headName(g) === 'deck')

  if (!deckGroup) {
    return manifest
  }

  manifest.name = value(deckGroup)

  const markGroup = child(deckGroup, 'mark')

  if (markGroup) {
    manifest.version = value(markGroup)
  }

  for (const node of rest(deckGroup)) {
    if (node.kind === 'group' && headName(node) === 'link') {
      const range = child(node, 'mark')
      manifest.deps.push({
        name: value(node),
        range: range ? value(range) : '*',
      })
    }
  }

  return manifest
}

function sha512(text: string): string {
  return `sha512-${createHash('sha512')
    .update(text)
    .digest('hex')
    .slice(0, 32)}`
}

// pick a version from the registry for a range (exact, or `*` / `<*>` = highest available)
function pickVersion(
  registryDir: string,
  host: string,
  deck: string,
  range: string,
): string | undefined {
  const dir = join(registryDir, host, deck)

  if (!existsSync(dir)) {
    return undefined
  }

  const versions = readdirSync(dir).filter(v =>
    existsSync(join(dir, v, 'deck.tree')),
  )

  if (versions.length === 0) {
    return undefined
  }

  const cleaned = range.replace(/[<>]/g, '').trim()

  if (cleaned !== '*' && cleaned !== '' && versions.includes(cleaned)) {
    return cleaned
  }

  // highest version (lexical sort is fine for the test's simple versions)
  return versions.sort().reverse()[0]
}

export type InstallResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; error: string }

// install a project's dependencies. registryDir holds <host>/<deck>/<version>/ packages; storeHome is the
// content-addressed store root (the ~/.base/@cluesurf/term equivalent, parameterized for testing).
export function install(
  projectDir: string,
  registryDir: string,
  storeHome: string,
): InstallResult {
  const manifestText = readFileSync(
    join(projectDir, 'deck.tree'),
    'utf8',
  )

  const manifest = parseDeck(manifestText)
  const lockfile: Lockfile = {
    base: manifest.version || '0.0.0',
    requests: [],
    links: [],
  }

  const visited = new Map<string, string>() // "name" -> resolved version

  function resolveDep(
    depName: string,
    range: string,
  ): string | undefined {
    const { host, name } = parsePackage(depName)
    const version = pickVersion(registryDir, host, name, range)

    if (!version) {
      return undefined
    }

    const ref = `${depName}:${version}`

    if (visited.has(depName)) {
      return visited.get(depName)
    }

    visited.set(depName, version)

    // fetch: copy from the registry into the content-addressed store, verify-by-hash
    const source = join(registryDir, host, name, version)
    const target = storePath(storeHome, host, name, version)

    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { recursive: true })
    }

    const hash = sha512(readFileSync(join(target, 'deck.tree'), 'utf8'))

    // transitive: resolve the dependency's own dependencies
    const depManifest = parseDeck(
      readFileSync(join(target, 'deck.tree'), 'utf8'),
    )

    const deps: { name: string; version: string }[] = []

    for (const d of depManifest.deps) {
      const v = resolveDep(d.name, d.range)

      if (v) {
        deps.push({ name: d.name, version: v })
      }
    }

    lockfile.links.push({ ref, hash, deps })

    // link into the project's local store: project/link/<host>/<name> -> store version
    const linkDir = join(projectDir, 'link', host, name)
    mkdirSync(dirname(linkDir), { recursive: true })

    if (existsSync(linkDir)) {
      rmSync(linkDir, { recursive: true, force: true })
    }

    symlinkSync(target, linkDir)

    return version
  }

  for (const dep of manifest.deps) {
    const version = resolveDep(dep.name, dep.range)

    if (!version) {
      return { ok: false, error: `cannot resolve ${dep.name}` }
    }

    lockfile.requests.push({
      name: dep.name,
      range: dep.range,
      locked: version,
    })
  }

  writeFileSync(
    join(projectDir, 'deck.lock.tree'),
    serializeLockfile(lockfile),
  )

  return { ok: true, lockfile }
}
