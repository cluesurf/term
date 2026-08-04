import {
  loadManifest,
  validateManifest,
  showCode,
  buildRelease,
  publishPackage,
  localObjectStore,
  httpRegistry,
  generateKeypair,
  BASE_API,
} from '@cluesurf/deck.tree'

import {
  logGood,
  logFail,
  logStep,
  formatError,
  fade,
} from '@term/make/code/tint'



export async function callHost(input: {
  root: string
  dryRun?: boolean
  // Override the registry host. Defaults to `BASE_API`; useful for staging, a local
  // server, or while a host is being cut over.
  registry?: string
}): Promise<void> {
  logStep('Reading deck.tree...')

  try {
    const manifest = await loadManifest({ dir: input.root })
    const errors = await validateManifest({ manifest })

    if (errors.length > 0) {
      for (const err of errors) {
        logFail(err)
      }

      process.exit(1)
    }

    const name = manifest.host
      ? `@${manifest.host}/${manifest.name}`
      : manifest.name
    const version = showCode(manifest.code)

    // Build the release locally first. This walks and chunks the package, writes the
    // @term/base prolly tree, and commits it, without contacting anything.
    const local = localObjectStore()
    const release = await buildRelease({
      dir: input.root,
      store: local,
      meta: {
        author: manifest.mind?.[0]?.name ?? 'unknown',
        time: Date.now(),
        message: `${name} ${version}`,
      },
    })

    logStep(
      `Built ${name}@${version}: ${release.files.length} files, ${release.closure.length} objects`,
    )

    if (input.dryRun) {
      console.log('')
      console.log(fade('  Dry run. Nothing uploaded.'))
      console.log(fade(`  commit ${release.commit}`))
      console.log(fade(`  root   ${release.root}`))

      for (const file of release.files.slice(0, 40)) {
        console.log(fade(`  ${file.mode.padEnd(4)} ${file.path}`))
      }

      if (release.files.length > 40) {
        console.log(fade(`  … ${release.files.length - 40} more`))
      }

      return
    }

    const token = await loadPublishToken()

    if (!token) {
      logFail(
        'Not authenticated. Set TERM_TOKEN, or write the token to ~/.base/term/auth',
      )
      process.exit(1)
    }

    const keypair = await loadPublishKeypair()

    const api = input.registry ?? BASE_API

    logStep(`Publishing ${name}@${version} to ${api}...`)

    const result = await publishPackage({
      dir: input.root,
      package: name,
      target: { kind: 'version', version },
      local,
      registry: httpRegistry({ baseUrl: api, token }),
      keypair,
      author: manifest.mind?.[0]?.name ?? 'unknown',
      time: new Date().toISOString(),
      message: `${name} ${version}`,
    })

    logGood(
      `Published ${name}@${version} (${result.uploaded} objects in ${result.packs} packs)`,
    )
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}

// The publish token: `TERM_TOKEN` first so a CI run needs no filesystem state, then the
// file. One token, one publisher, matching the registry's current auth.
async function loadPublishToken(): Promise<string | undefined> {
  const fromEnv = process.env['TERM_TOKEN']?.trim()

  if (fromEnv) {
    return fromEnv
  }

  const os = await import('os')
  const nodePath = await import('path')
  const fs = await import('fs/promises')

  try {
    const text = await fs.readFile(
      nodePath.join(os.homedir(), '.base/term/auth'),
      'utf-8',
    )

    return text.trim() || undefined
  } catch {
    return undefined
  }
}

// The signing keypair. A release is signed so authorship cannot be forged; the registry
// checks the signature against the keys allowed to publish the scope.
async function loadPublishKeypair(): Promise<{
  publicKey: string
  privateKey: string
}> {
  const os = await import('os')
  const nodePath = await import('path')
  const fs = await import('fs/promises')
  const file = nodePath.join(os.homedir(), '.base/term/key')

  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as {
      publicKey: string
      privateKey: string
    }
  } catch {
    // first publish on this machine: mint a keypair and keep it
    const pair = generateKeypair()
    await fs.mkdir(nodePath.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(pair, null, 2), {
      mode: 0o600,
    })

    return pair
  }
}
