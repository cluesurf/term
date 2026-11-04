/**
 * Install @term/* packages from the content-addressed registry (base.term.surf)
 * into a project's `link/` — the install counterpart of task/term/publish-objects.ts,
 * and what `term load` does. For each requested package it resolves the ref
 * to a commit, fetches the missing objects (verified by hash), and checks the
 * file tree out under `link/.seed/@term/<name>@<version>/` where the project's
 * resolver finds it.
 *
 * No token needed — object reads are public. The local object cache is the
 * shared `~/.term/store` (so re-installs are fast).
 *
 * Usage:
 *   pnpm tsx task/term/install-objects.ts --project mesh/site/form.surf/home --only make,call
 *   pnpm tsx task/term/install-objects.ts --project mesh/site/term.surf/home --only site,make,call
 *   pnpm tsx task/term/install-objects.ts --project <dir> --only <names> --version 0.0.2 --registry <url>
 */

import { parseArgs } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TERM_ROOT } from './root'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = TERM_ROOT
const OBJ = path.join(TERM_ROOT, 'deck/deck/code/object')

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      only: { type: 'string' },
      version: { type: 'string' },
      registry: { type: 'string' },
    },
  })

  if (!values.project || !values.only) {
    throw new Error('usage: --project <dir> --only <names> [--version 0.0.2] [--registry url]')
  }

  const baseUrl = values.registry ?? 'https://base.term.surf'
  const version = values.version ?? '0.0.2'
  const projectDir = path.isAbsolute(values.project)
    ? values.project
    : path.join(REPO_ROOT, values.project)
  const names = values.only.split(',').map(s => s.trim()).filter(Boolean)

  const { localObjectStore } = await import(path.join(OBJ, 'store.ts'))
  const { httpRegistry } = await import(path.join(OBJ, 'http.ts'))
  const { installPackage } = await import(path.join(OBJ, 'install.ts'))

  const local = localObjectStore()
  const registry = httpRegistry({ baseUrl })

  console.log(`installing from ${baseUrl} into ${values.project}/link/.seed/@term`)
  let failures = 0

  for (const name of names) {
    const pkg = `@term/${name}`
    const dest = path.join(projectDir, 'link', '.seed', '@term', `${name}@${version}`)
    try {
      const { commitId, fetched } = await installPackage({
        package: pkg,
        ref: { kind: 'version', version },
        dest,
        local,
        registry,
      })
      // Make the package Node-resolvable (for build scripts + the compiler's own
      // imports), not just tree-resolvable via `link/`. Symlink it under BOTH
      // `node_modules/@term/<name>` (the registry name a build's `make.ts` imports)
      // and `node_modules/@cluesurf/<name>` (the legacy scope the @term/make
      // compiler still self-references internally). Relative link so it survives a
      // project move.
      for (const scope of ['@term', '@cluesurf']) {
        const scopeDir = path.join(projectDir, 'node_modules', scope)
        fs.mkdirSync(scopeDir, { recursive: true })
        const linkPath = path.join(scopeDir, name)
        try {
          fs.rmSync(linkPath, { force: true, recursive: true })
        } catch {
          // nothing there yet
        }
        fs.symlinkSync(path.relative(scopeDir, dest), linkPath)
      }
      console.log(`  ok ${pkg}@${version}  fetched ${fetched}  commit ${commitId.slice(0, 19)}…`)
    } catch (error) {
      failures += 1
      console.error(`  FAIL ${pkg}@${version}: ${error instanceof Error ? error.message : error}`)
    }
  }

  console.log(failures ? `done — ${failures} failed` : `done — ${names.length}/${names.length} installed`)
  if (failures) process.exit(1)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
