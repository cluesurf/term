// End-to-end package-manager install test: a local registry with a transitive dependency, installed into a temp
// project, verifying the content-addressed store, the project links, transitive resolution, and the lockfile.
// Run: npx tsx test/deck/install.ts

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '@term/make/code/deck/install'
import { storePath } from '@term/make/code/deck/resolve'

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

function writePackage(
  registry: string,
  host: string,
  name: string,
  version: string,
  deckText: string,
): void {
  const dir = join(registry, host, name, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'deck.tree'), deckText)
  writeFileSync(join(dir, 'code.tree'), `task hello\n  back, code 1\n`)
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'seed-install-'))
  const registry = join(root, 'registry')
  const storeHome = join(root, 'store')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })

  // registry: package b (no deps), package a (depends on b)
  writePackage(
    registry,
    'termsurf',
    'b',
    '0.0.1',
    `deck @termsurf/b\n  mark <0.0.1>\n`,
  )
  writePackage(
    registry,
    'termsurf',
    'a',
    '0.0.1',
    `deck @termsurf/a\n  mark <0.0.1>\n  link @termsurf/b\n    mark <*>\n`,
  )

  // project depends on a (which transitively needs b)
  writeFileSync(
    join(project, 'deck.tree'),
    `deck @my/app\n  mark <0.1.0>\n  link @termsurf/a\n    mark <*>\n`,
  )

  const result = install(project, registry, storeHome)
  expect('install succeeds', result.ok, true)

  if (!result.ok) {
    console.log(`\ninstall: ${pass} pass, ${fail + 1} fail`)

    return
  }

  // the content-addressed store holds both the direct and the transitive dependency
  expect(
    'store has a',
    existsSync(storePath(storeHome, 'termsurf', 'a', '0.0.1')),
    true,
  )
  expect(
    'store has b (transitive)',
    existsSync(storePath(storeHome, 'termsurf', 'b', '0.0.1')),
    true,
  )
  expect(
    'store copied files',
    existsSync(
      join(storePath(storeHome, 'termsurf', 'a', '0.0.1'), 'code.tree'),
    ),
    true,
  )

  // the project links to both, as symlinks into the store
  const linkA = join(project, 'link', 'termsurf', 'a')
  const linkB = join(project, 'link', 'termsurf', 'b')
  expect('project links a', lstatSync(linkA).isSymbolicLink(), true)
  expect('project links b', lstatSync(linkB).isSymbolicLink(), true)
  expect(
    'link resolves to store file',
    existsSync(join(linkA, 'code.tree')),
    true,
  )

  // the lockfile records the resolved graph
  expect(
    'lockfile requests a',
    result.lockfile.requests.some(
      r => r.name === '@termsurf/a' && r.locked === '0.0.1',
    ),
    true,
  )
  expect('lockfile links a and b', result.lockfile.links.length, 2)

  const aLink = result.lockfile.links.find(l =>
    l.ref.startsWith('@termsurf/a'),
  )

  expect(
    'a depends on b in lockfile',
    aLink?.deps.some(d => d.name === '@termsurf/b'),
    true,
  )

  // the lockfile was written to disk
  expect(
    'lockfile on disk',
    existsSync(join(project, 'deck.lock.tree')),
    true,
  )
  expect(
    'lockfile mentions b',
    readFileSync(join(project, 'deck.lock.tree'), 'utf8').includes(
      '@termsurf/b',
    ),
    true,
  )

  console.log(`\ninstall: ${pass} pass, ${fail} fail`)
}

main()
