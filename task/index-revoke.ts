// `pnpm term:index-revoke`: take versions of a package out of the term.surf package index (note/term/registry/19), so
// its page and `term self find` stop offering them. The index never deletes a version: a revoke marks it, and the
// version leaves every listing.
//
//   pnpm term:index-revoke @term/code 2.7.0 2.7.4                    report what would be revoked
//   pnpm term:index-revoke @term/code 2.7.0 2.7.4 --reason "..." --commit   revoke them
//
// The index accepts a revoke signed by a key of the scope's key set: `term.revoke.v1 <name> <version> <digest> <time>`
// (mesh/deck/back/code/resource/package/oci.ts `revokeStatement`), within ten minutes of now. It signs with this
// machine's publish key, the one `term host` and `pnpm term:release` sign with (call/code/host.ts
// `loadPublishKeypair`), and reads each version's digest from the index itself. Written 2026-10-22, when 2.6.0 to 2.7.4
// were deleted from ghcr for carrying build caches with a machine's paths and the index still listed 2.7.0 and 2.7.4.

import { signId } from '@cluesurf/deck.tree'
import { loadPublishKeypair } from '@term/call/code/host'

const INDEX = (process.env['TERM_INDEX_URL']?.trim() || 'https://tool.term.surf').replace(/\/+$/, '')

// the index refuses an unnamed automated client, and `term` is the name the CLI's own ping sends
const AGENT = 'term'

type Indexed = { version: string; digest: string; revocation?: unknown }

const args = process.argv.slice(2)
const commit = args.includes('--commit')
const reasonAt = args.indexOf('--reason')
const reason = reasonAt >= 0 ? args[reasonAt + 1] : undefined
const [name, ...versions] = args.filter((arg, at) => !arg.startsWith('--') && (reasonAt < 0 || at !== reasonAt + 1))

function fail(message: string): never {
  console.error(`index-revoke: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  if (!name || versions.length === 0) {
    fail('name a package and its versions: pnpm term:index-revoke @term/code 2.7.0 2.7.4')
  }

  const response = await fetch(`${INDEX}/packages/select!?name=${name}`, { headers: { 'user-agent': AGENT } })
  if (!response.ok) {
    fail(`read ${name} from ${INDEX}: ${response.status} ${await response.text()}`)
  }
  const answer = (await response.json()) as { base?: { package_version?: { list?: Indexed[] } }; package_version?: { list?: Indexed[] } }
  const indexed = (answer.base ?? answer).package_version?.list ?? []

  const keypair = await loadPublishKeypair({ mint: false })
  if (!keypair) {
    fail('this machine has no publish key, so nothing can be signed')
  }

  for (const version of versions) {
    const found = indexed.find(one => one.version === version)
    if (!found) {
      fail(`${name}@${version} is not in the index`)
    }
    if (found.revocation) {
      console.log(`  ${name}@${version} is revoked already`)
      continue
    }
    if (!commit) {
      console.log(`  would revoke ${name}@${version} (${found.digest.slice(0, 19)})`)
      continue
    }

    const time = new Date().toISOString()
    const statement = `term.revoke.v1 ${name} ${version} ${found.digest} ${time}`
    const sent = await fetch(`${INDEX}/packages/revoke!`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': AGENT },
      body: JSON.stringify({
        name,
        version,
        time,
        key: keypair.publicKey,
        sig: signId({ id: statement, privateKey: keypair.privateKey }),
        ...(reason ? { reason } : {}),
      }),
    })
    if (!sent.ok) {
      fail(`revoke ${name}@${version}: ${sent.status} ${await sent.text()}`)
    }
    console.log(`  revoked ${name}@${version}`)
  }

  if (!commit) {
    console.log('report only: --commit revokes them')
  }
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
