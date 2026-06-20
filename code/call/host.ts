import { spawn } from 'child_process'
import fsp from 'fs/promises'
import path from 'path'
import {
  loadManifest,
  showMark,
  toRegistryName,
  validateManifest,
} from '@cluesurf/deck.tree'
import type { DeckManifest, MarkHold } from '@cluesurf/deck.tree'

import { logGood, logFail, logStep, formatError, fade } from '../tint'

function holdToNpmRange(hold: MarkHold): string {
  switch (hold.form) {
    case 'exact':
      return showMark(hold.mark)
    case 'wild': {
      const minor = hold.minor !== undefined ? `${hold.minor}` : 'x'
      const patch = hold.patch !== undefined ? `${hold.patch}` : 'x'
      return `${hold.major}.${minor}.${patch}`
    }
    case 'band':
      return `>=${showMark(hold.base)} <${showMark(hold.head)}`
    case 'test':
      return hold.list.map(w => holdToNpmRange(w)).join(' || ')
  }
}

function manifestToPackageJson(
  manifest: DeckManifest,
): Record<string, unknown> {
  const fullName = manifest.host
    ? `@${manifest.host}/${manifest.name}`
    : manifest.name
  const npmName = toRegistryName({ name: fullName })
  const version = showMark(manifest.mark)

  const pkg: Record<string, unknown> = {
    name: npmName,
    version,
  }

  if (manifest.head) {
    pkg.description = manifest.head
  }

  if (manifest.mind && manifest.mind.length > 0) {
    const first = manifest.mind[0]
    if (first) {
      const author: Record<string, string> = { name: first.name }
      if (first.site) {
        author.url = first.site
      }
      pkg.author = author
    }
  }

  if (manifest.lock) {
    pkg.license = manifest.lock
  }

  if (manifest.term && manifest.term.length > 0) {
    pkg.keywords = manifest.term
  }

  if (manifest.link.length > 0) {
    const deps: Record<string, string> = {}
    for (const link of manifest.link) {
      const depNpmName = toRegistryName({ name: link.name })
      deps[depNpmName] = holdToNpmRange(link.mark)
    }
    pkg.dependencies = deps
  }

  return pkg
}

export async function callHost(input: {
  root: string
  dryRun?: boolean
}): Promise<void> {
  logStep('Reading deck.tree...')

  try {
    const manifest = await loadManifest({ dir: input.root })

    // validate
    const errors = await validateManifest({ manifest })
    if (errors.length > 0) {
      for (const err of errors) {
        logFail(err)
      }
      process.exit(1)
    }

    // generate package.json fields from deck.tree
    const generated = manifestToPackageJson(manifest)

    // read existing package.json if it exists, merge
    const pkgPath = path.join(input.root, 'package.json')
    let existing: Record<string, unknown> = {}
    try {
      const text = await fsp.readFile(pkgPath, 'utf-8')
      existing = JSON.parse(text)
    } catch {
      // no existing package.json
    }

    // merge: deck.tree fields override, but preserve everything else
    const merged = { ...existing, ...generated }

    // if existing had dependencies, merge them (deck.tree deps override, keep extras)
    if (
      typeof existing.dependencies === 'object' &&
      existing.dependencies !== null &&
      typeof generated.dependencies === 'object' &&
      generated.dependencies !== null
    ) {
      merged.dependencies = {
        ...(existing.dependencies as Record<string, string>),
        ...(generated.dependencies as Record<string, string>),
      }
    }

    // write merged package.json
    await fsp.writeFile(
      pkgPath,
      JSON.stringify(merged, null, 2) + '\n',
      'utf-8',
    )
    logStep(
      `Wrote package.json for ${String(merged.name)}@${String(
        merged.version,
      )}`,
    )

    if (input.dryRun) {
      console.log('')
      console.log(fade('  Dry run. Generated package.json:'))
      console.log(
        fade(
          '  ' +
            JSON.stringify(merged, null, 2).split('\n').join('\n  '),
        ),
      )
      return
    }

    // run npm publish
    logStep('Publishing to npm...')
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['publish', '--access=public'], {
        cwd: input.root,
        stdio: 'inherit',
        shell: true,
      })
      child.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`npm publish exited with code ${code}`))
      })
      child.on('error', reject)
    })

    logGood('Published successfully')
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
