/**
 * Publish the @term/* packages to the content-addressed registry
 * (base.term.surf) using the new delta-publish object protocol, not the
 * legacy tarball path. For each package: build its commit locally, upload
 * only the objects the server is missing, sign the commit, and create the
 * version.
 *
 * A persistent ed25519 keypair (~/.term/key.json) identifies the publisher;
 * the registry registers it on first use (trust-on-first-use for the scope
 * owner). The Bearer publish token is read from ~/.seed/auth.
 *
 * Usage:
 *   pnpm tsx task/term/publish-objects.ts                 # all packages
 *   pnpm tsx task/term/publish-objects.ts --only base,site,face,bind,form
 *   pnpm tsx task/term/publish-objects.ts --registry http://127.0.0.1:8787
 */

import { parseArgs } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TERM_ROOT, parentRoot } from './root'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = TERM_ROOT
const OBJ = path.join(
  REPO_ROOT,
  'deck/deck/code/object',
)
const DECK_ROOT = path.join(TERM_ROOT, 'deck')
const LIB_ROOT = (): string => path.join(parentRoot(), 'deck/term/deck')

// package short-name -> source dir (sub-packages under DECK_ROOT; libraries
// bind/form as <name>.tree under LIB_ROOT), leaf-first
const PACKAGE_DIRS: Record<string, string> = {
  bind: path.join(LIB_ROOT(), 'bind.tree'),
  base: path.join(DECK_ROOT, 'base'),
  form: path.join(LIB_ROOT(), 'form.tree'),
  site: path.join(DECK_ROOT, 'site'),
  face: path.join(DECK_ROOT, 'face'),
  // @term/make (the compiler) + its closed dependency graph (@term/call resolver,
  // @term/deck package manager, @term/test, @term/scan) so self-contained Term
  // apps (form.surf, term.surf) install their own build toolchain from the
  // registry and compile their `.tree` with `pnpm make` — no monorepo checkout.
  make: path.join(DECK_ROOT, 'make'),
  call: path.join(DECK_ROOT, 'call'),
  deck: path.join(DECK_ROOT, 'deck'),
  test: path.join(DECK_ROOT, 'test'),
  scan: path.join(DECK_ROOT, 'scan'),
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      registry: { type: 'string' },
    },
  })

  const baseUrl = values.registry ?? 'https://base.term.surf'
  const only = values.only
    ? values.only.split(',').map(s => s.trim()).filter(Boolean)
    : Object.keys(PACKAGE_DIRS)

  const { loadManifest } = await import(path.join(DECK_ROOT, 'deck/code/package/manifest.ts'))
  const { showCode } = await import(path.join(DECK_ROOT, 'deck/code/code.ts'))
  // showMark became showCode (exact versions) and a link's constraint is a code-hold: write each form
  type Hold = { form: string; code?: unknown; major?: number; minor?: number; patch?: number; base?: unknown; head?: unknown; list?: Hold[] }
  const showHold = (hold: Hold): string => {
    const part = (n: number | undefined) => (n === undefined || n < 0 ? 'x' : String(n))
    switch (hold.form) {
      case 'exact': return showCode(hold.code)
      case 'wild': return `${part(hold.major)}.${part(hold.minor)}.${part(hold.patch)}`
      case 'band': return `${showCode(hold.base)} - ${showCode(hold.head)}`
      default: return (hold.list ?? []).map(showHold).join(' || ')
    }
  }
  const { localObjectStore } = await import(path.join(OBJ, 'store.ts'))
  const { httpRegistry } = await import(path.join(OBJ, 'http.ts'))
  const { publishPackage } = await import(path.join(OBJ, 'publish.ts'))
  const { generateKeypair } = await import(path.join(OBJ, 'sign.ts'))

  // persistent publisher keypair
  const keyPath = path.join(os.homedir(), '.term', 'key.json')
  let keypair: { publicKey: string; privateKey: string }

  if (fs.existsSync(keyPath)) {
    keypair = JSON.parse(fs.readFileSync(keyPath, 'utf8'))
  } else {
    keypair = generateKeypair()
    fs.mkdirSync(path.dirname(keyPath), { recursive: true })
    fs.writeFileSync(keyPath, JSON.stringify(keypair, null, 2), { mode: 0o600 })
    console.log(`generated publisher key -> ${keyPath}`)
  }

  // Bearer publish token
  const authPath = path.join(os.homedir(), '.seed', 'auth')
  const token = fs.existsSync(authPath)
    ? fs.readFileSync(authPath, 'utf8').trim()
    : undefined

  if (!token) {
    throw new Error('no publish token at ~/.seed/auth')
  }

  const local = localObjectStore()
  const registry = httpRegistry({ baseUrl, token })

  console.log(`publishing to ${baseUrl}`)
  let failures = 0

  for (const short of only) {
    const dir = PACKAGE_DIRS[short]

    if (!dir) {
      console.log(`  ? unknown package ${short}`)
      continue
    }

    try {
      const manifest = await loadManifest({ dir })
      const pkg = manifest.host
        ? `@${manifest.host}/${manifest.name}`
        : manifest.name
      const version = showCode(manifest.mark)
      const deps: Record<string, string> = {}

      for (const link of manifest.link ?? []) {
        deps[link.name] = showHold(link.mark as Hold)
      }

      const result = await publishPackage({
        dir,
        package: pkg,
        target: { kind: 'version', version },
        local,
        registry,
        keypair,
        author: 'user:lp@elk.fm',
        time: new Date().toISOString(),
        deps,
      })

      console.log(
        `  ok ${pkg}@${version}  uploaded ${result.uploaded} objects  ${result.ref}`,
      )
    } catch (error) {
      failures += 1
      const message = error instanceof Error ? error.message : String(error)
      console.log(`  FAIL ${short}: ${message}`)
    }
  }

  console.log(`done — ${only.length - failures}/${only.length} published`)

  if (failures > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
