// pnpm check:term-oci: ORAS as the independent second implementation of the Term OCI artifact.
//
// A check that runs `term host` and then `term load` only shows that Term agrees with itself. This one puts ORAS and
// the system tar, which know nothing about Term, on the other side of every exchange. Artifact format v2 (decision 129
// section 2 of the self-host change, decisions 154 and 158): one gzip ustar archive layer, signed in the config.
//
//   1. term publishes          oras manifest fetch   the bytes ORAS reads are the manifest Term wrote
//   2. term publishes          oras pull             the one layer lands under its title and hashes to its digest
//   3. term publishes          tar -xzf              the pulled archive extracts to the package's files, byte for byte
//   4. oras cp                 term installs         a layout ORAS wrote installs byte for byte
//   5. oras push, by hand      term installs         an artifact ORAS built from the archive and config files installs
//
// It runs against OCI image layouts on disk (`oras --oci-layout`), so it needs ORAS and no registry server. Without
// `oras` on the PATH it prints SKIP and exits 0, or exits 1 under --require, because a check that cannot run has not
// passed. Writes only under a scratch directory, which it reports.

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

import { generateKeypair } from '../../deck/deck/code/object/sign'
import { layoutTransport } from '../../deck/deck/code/oci/layout'
import { installOciVersion, readOciVersion } from '../../deck/deck/code/oci/install'
import { publishToOci } from '../../deck/deck/code/oci/publish'

const run = promisify(execFile)
const mustRun = process.argv.includes('--require')

// the marker an install writes at the top of the version's folder (decision 154 section 3), never a package file
const MARKER = '.term-digest'

type Result = { name: string; ok: boolean; detail: string }

const sha = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

async function oras(args: string[]): Promise<string> {
  const { stdout } = await run('oras', args, { maxBuffer: 64 * 1024 * 1024 })

  return stdout
}

async function treeOf(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()

  const walk = async (at: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(dir, at), { withFileTypes: true })) {
      const rel = path.join(at, entry.name)

      if (rel === MARKER) {
        continue
      }

      if (entry.isDirectory()) {
        await walk(rel)
      } else {
        out.set(rel, sha(await fs.readFile(path.join(dir, rel))))
      }
    }
  }

  await walk('')

  return out
}

function sameTree(a: Map<string, string>, b: Map<string, string>): string | undefined {
  for (const [file, digest] of a) {
    if (b.get(file) !== digest) {
      return `${file} differs or is missing`
    }
  }

  for (const file of b.keys()) {
    if (!a.has(file)) {
      return `${file} was not in the source`
    }
  }

  return undefined
}

async function main(): Promise<void> {
  try {
    await run('oras', ['version'])
  } catch {
    console.log('SKIP  check:term-oci: oras is not on the PATH (https://oras.land/docs/installation). Nothing was checked')
    process.exit(mustRun ? 1 : 0)
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'term-oci-witness-'))
  const source = path.join(work, 'source')
  const files: Record<string, string | Buffer> = {
    'readme.md': '# witness\n',
    'code/one.ts': 'export const one = 1\n',
    'code/two.ts': 'export const two = 2\n',
    'font/glyph.bin': Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 31) % 256)),
    'data/large.txt': 'term '.repeat(20_000),
  }

  for (const [at, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, at)), { recursive: true })
    await fs.writeFile(path.join(source, at), body)
  }

  const results: Result[] = []
  const check = async (name: string, body: () => Promise<string | undefined>): Promise<void> => {
    try {
      const problem = await body()
      results.push({ name, ok: problem === undefined, detail: problem ?? '' })
    } catch (error) {
      results.push({ name, ok: false, detail: (error as Error).message.split('\n')[0] ?? '' })
    }
  }

  // a single-repository layout with bare tags, which is the shape `oras --oci-layout <dir>:<tag>` reads and writes
  const layout = path.join(work, 'layout')
  const transport = layoutTransport({ dir: layout, bare: true })
  const repository = { host: 'layout', namespace: 'term', name: 'term/witness' }
  const keypair = generateKeypair()

  const published = await publishToOci({
    dir: source,
    package: '@term/witness',
    version: '1.0.0',
    link: [],
    transport,
    repository,
    scope: '@term',
    keysRepository: 'term',
    keypair,
  })

  const manifest = JSON.parse(published.artifact.manifest.toString('utf8')) as {
    artifactType: string
    config: { mediaType: string; digest: string }
    layers: { mediaType: string; digest: string; annotations: Record<string, string> }[]
  }

  const install = async (input: { dir: string; reference: string; into: string }): Promise<string | undefined> => {
    const from = layoutTransport({ dir: input.dir, bare: true })
    const version = await readOciVersion({
      transport: from,
      repository: 'term/witness',
      package: '@term/witness',
      reference: input.reference,
      scope: '@term',
      keysRepository: 'term',
      host: 'layout',
      trustDir: path.join(work, `trust-${path.basename(input.into)}`),
      env: { TERM_TRUSTED_KEYS: `@term=${keypair.publicKey}` },
    })

    await installOciVersion({
      transport: from,
      repository: 'term/witness',
      version,
      dest: input.into,
    })

    const marker = await fs.readFile(path.join(input.into, MARKER), 'utf8')

    if (marker !== `${version.digest}\n`) {
      return `the install's marker reads ${JSON.stringify(marker)}, not the manifest digest ${version.digest}`
    }

    return sameTree(await treeOf(source), await treeOf(input.into))
  }

  await check('oras manifest fetch reads the manifest term wrote', async () => {
    const fetched = Buffer.from(await oras(['manifest', 'fetch', '--oci-layout', `${layout}:1.0.0`]))
    const digest = sha(Buffer.from(fetched.toString('utf8').trim()))

    return digest === published.digest || sha(fetched) === published.digest ? undefined : `oras read ${sha(fetched)}, term wrote ${published.digest}`
  })

  const pulled = path.join(work, 'pulled')

  await check('oras pull writes the one layer under its title, matching its digest', async () => {
    await oras(['pull', '--oci-layout', `${layout}:1.0.0`, '-o', pulled])

    if (manifest.layers.length !== 1) {
      return `the manifest holds ${manifest.layers.length} layers, not the one archive`
    }

    const layer = manifest.layers[0]!
    const title = layer.annotations['org.opencontainers.image.title']!
    const bytes = await fs.readFile(path.join(pulled, title))

    return sha(bytes) === layer.digest ? undefined : `${title} hashes to ${sha(bytes)}, not ${layer.digest}`
  })

  await check('the system tar extracts the pulled archive to the package files, byte for byte', async () => {
    const title = manifest.layers[0]!.annotations['org.opencontainers.image.title']!
    const extracted = path.join(work, 'extracted')
    await fs.mkdir(extracted, { recursive: true })
    await run('tar', ['-xzf', path.join(pulled, title), '-C', extracted])

    return sameTree(await treeOf(source), await treeOf(extracted))
  })

  await check('a layout oras cp wrote installs byte for byte', async () => {
    const copied = path.join(work, 'copied')
    await oras(['cp', '--from-oci-layout', `${layout}:1.0.0`, '--to-oci-layout', `${copied}:1.0.0`])

    return install({ dir: copied, reference: '1.0.0', into: path.join(work, 'from-cp') })
  })

  await check('an artifact oras push built from the archive and config files installs', async () => {
    const pushed = path.join(work, 'pushed')
    const configFile = path.join(work, 'config.json')
    await oras(['blob', 'fetch', '--oci-layout', `${layout}@${manifest.config.digest}`, '--output', configFile])

    // the layer and config ORAS writes must be the signed ones (decision 158 rule 2): same bytes, same media types.
    // The manifest's annotations are ORAS's own, and nothing reads them
    const args = [
      'push',
      '--oci-layout',
      `${pushed}:1.0.0`,
      '--artifact-type',
      manifest.artifactType,
      '--config',
      `${configFile}:${manifest.config.mediaType}`,
      '--disable-path-validation',
    ]

    for (const layer of manifest.layers) {
      args.push(`${layer.annotations['org.opencontainers.image.title']}:${layer.mediaType}`)
    }

    await run('oras', args, { cwd: pulled, maxBuffer: 64 * 1024 * 1024 })

    return install({ dir: pushed, reference: '1.0.0', into: path.join(work, 'from-push') })
  })

  for (const result of results) {
    console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.detail ? `: ${result.detail}` : ''}`)
  }

  const failed = results.filter(result => !result.ok).length
  console.log(`\n${results.length - failed} of ${results.length} witness checks pass. Scratch: ${work}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
