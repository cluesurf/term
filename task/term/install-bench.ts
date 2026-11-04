// `pnpm term:install-bench`: what installing a Term package costs, measured on real packages through the real
// publish and install code, over HTTP to the in-process OCI registry the tests use (deck/deck/test/oci-server.ts).
// The numbers the guide quotes (note/project/term/guides/draft/packages/install.md, "How it is built") come from here.
//
// For each package (the standard library, deck/base/code, and the largest, deck/bind/code), a copy is published as
// 1.0.0, then:
//
//   cold      a project installs it into an empty machine store
//   warm      a second project installs the same version from that store
//   upgrade   one line of one file changes, 1.0.2 is published, and the first project's store installs it
//   tarball   the same folder as one gzipped tarball, which is what a tarball registry (npm's) sends for EVERY version
//
// Reports and writes nothing outside tmp/. Timings are the best of three, on a warm disk cache.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TERM_ROOT } from './root'

// run from the Term root (the alias cds there), the way every other term task is. `import.meta` is not
// available: the root task folder runs as CommonJS, which is also why everything below is inside `main`
const TERM = TERM_ROOT
const DECK = path.join(TERM, 'deck/deck')

async function main(): Promise<void> {
const { generateKeypair } = await import(path.join(DECK, 'code/object/sign.ts'))
const { installOciVersion, readOciVersion } = await import(path.join(DECK, 'code/oci/install.ts'))
const { layoutObjectStore } = await import(path.join(DECK, 'code/oci/layout.ts'))
const { publishToOci } = await import(path.join(DECK, 'code/oci/publish.ts'))
const { parseOciRegistry, repositoryOf } = await import(path.join(DECK, 'code/oci/reference.ts'))
const { httpTransport } = await import(path.join(DECK, 'code/oci/transport.ts'))
const { startOciServer } = await import(path.join(DECK, 'test/oci-server.ts'))

const TIME = '2026-01-01T00:00:00.000Z'
const PACKAGES = [
  { name: '@term/base', from: path.join(TERM, 'deck/base/code') },
  { name: '@term/bind', from: path.join(TERM, 'deck/bind/code') },
]

function folderBytes(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0

  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      files += 1
      bytes += statSync(path.join(entry.parentPath, entry.name)).size
    }
  }

  return { files, bytes }
}

// the first .tree file over 2 KB, in name order, so every run edits the same one
function fileToEdit(dir: string): string {
  const all = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.tree'))
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort()

  return all.find(file => statSync(file).size > 2048) ?? all[0]!
}

async function best<T>(times: number, run: (at: number) => Promise<T>): Promise<{ ms: number; value: T }> {
  let fastest = Infinity
  let value!: T

  for (let at = 0; at < times; at++) {
    const started = performance.now()
    value = await run(at)
    fastest = Math.min(fastest, performance.now() - started)
  }

  return { ms: fastest, value }
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

const work = mkdtempSync(path.join(TERM, 'tmp', 'install-bench-'))
// removed however the run ends: a throw, ctrl-c or SIGTERM as well as the end. Every failed run used to leave its whole
// work folder (each package's cold-store-*, three cold installs, three warm ones) in tmp/ (term-cli-in-term-0177)
const removeWork = (): void => rmSync(work, { recursive: true, force: true })

process.on('exit', removeWork)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(130))
}

const server = await startOciServer()
const transport = httpTransport({ host: server.host, credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }) })
const registry = parseOciRegistry('oci://127.0.0.1/term')
const keypair = generateKeypair()
const rows: string[] = []

for (const one of PACKAGES) {
  const slug = one.name.split('/')[1]!
  const source = path.join(work, slug, 'src')

  cpSync(one.from, path.join(source, 'code'), { recursive: true, filter: from => !/[\\/](host|node_modules|tmp|\.base)([\\/]|$)/.test(from) })
  writeFileSync(path.join(source, 'deck.tree'), `deck ${one.name}\n  mark <1.0.0>\n`)

  const repository = repositoryOf({ package: one.name, registry: { ...registry, host: server.host } })
  const publish = (version: string) =>
    publishToOci({
      dir: source,
      package: one.name,
      version,
      target: { kind: 'version', version },
      link: [],
      transport,
      repository,
      scope: '@term',
      keysRepository: 'term',
      local: layoutObjectStore({ dir: path.join(work, slug, 'publisher') }),
      keypair,
      author: 'bench',
      time: TIME,
    })
  const read = (version: string) =>
    readOciVersion({ transport, repository: repository.name, package: one.name, reference: version, scope: '@term', keysRepository: 'term', host: server.host, trustDir: path.join(work, 'trust'), env: {} })

  const first = await publish('1.0.0')
  const v1 = await read('1.0.0')

  // cold: a fresh store each time, so each of the three runs is a first install
  const cold = await best(3, at => {
    const store = path.join(work, slug, `cold-store-${at}`)

    return installOciVersion({ transport, repository: repository.name, version: v1, dest: path.join(work, slug, `cold-${at}`), local: layoutObjectStore({ dir: store }) })
  })
  const store = path.join(work, slug, 'cold-store-0')
  const storeBytes = folderBytes(store).bytes
  // the package as installed: what was published, and the file set the tarball comparison is made of
  const checkout = path.join(work, slug, 'cold-0')
  const size = folderBytes(checkout)
  const tarball = path.join(work, slug, 'package.tgz')

  execFileSync('tar', ['-czf', tarball, '-C', checkout, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

  const tarBytes = statSync(tarball).size
  const filesLayer = v1.manifest.files.size as number
  const sum = (layers: { size: number }[]) => layers.reduce((total, layer) => total + layer.size, 0)
  const packBytes = sum(v1.manifest.packs)
  const looseBytes = sum(v1.manifest.loose)

  // warm: another project, the same store
  const warm = await best(3, at => installOciVersion({ transport, repository: repository.name, version: v1, dest: path.join(work, slug, `warm-${at}`), local: layoutObjectStore({ dir: store }) }))

  // upgrade: one line appended to one file
  const edited = fileToEdit(path.join(source, 'code'))

  writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n# changed by the install benchmark\n`)

  const second = await publish('1.0.2')
  const v2 = await read('1.0.2')
  const upgrade = await installOciVersion({ transport, repository: repository.name, version: v2, dest: path.join(work, slug, 'upgraded'), local: layoutObjectStore({ dir: store }) })

  rows.push(
    [
      `${one.name}: ${size.files} files, ${kb(size.bytes)}`,
      `  published 1.0.0     ${first.blobs.total} blobs, ${kb(first.bytes.total)}`,
      `  tarball, gzip       ${kb(tarBytes)}, sent in full for every version by a tarball registry`,
      `  cold install        ${cold.ms.toFixed(0)} ms, ${kb(cold.value.bytes)} fetched, ${cold.value.packsFetched} packs, ${cold.value.looseFetched} loose`,
      `  warm install        ${warm.ms.toFixed(0)} ms, ${kb(warm.value.bytes)} fetched, ${warm.value.packsFetched} packs, ${warm.value.looseFetched} loose`,
      `  files layer         ${kb(filesLayer)}, read on every install`,
      `  of a cold install   files layer ${kb(filesLayer)}, ${v1.manifest.packs.length} packs ${kb(packBytes)} (gzip), ${v1.manifest.loose.length} loose ${kb(looseBytes)} (as stored)`,
      `  machine store       ${kb(storeBytes)}, once per machine`,
      `  project checkout    ${kb(size.bytes)}, once per project (files are written, not linked)`,
      `  edited              ${path.relative(source, edited)}, one line`,
      `  published 1.0.2     ${second.blobs.uploaded} of ${second.blobs.total} blobs uploaded, ${kb(second.bytes.uploaded)} of ${kb(second.bytes.total)}`,
      `  upgrade install     ${kb(upgrade.bytes)} fetched, ${upgrade.packsFetched} packs fetched, ${upgrade.packsSkipped} skipped, ${upgrade.looseFetched} loose`,
    ].join('\n'),
  )
}

await server.close()
removeWork()

console.log(`${rows.join('\n\n')}\n\nnode ${process.version}, ${process.platform}-${process.arch}, loopback HTTP`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
