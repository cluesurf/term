// Build a sealed cache for the load harness: make a master key, seal the
// values it is given, and write both the cache and the key out.
//
//   tsx test/make-cache.ts <project-dir>
//
// Prints the tone-packed master key on stdout, which the harness puts in
// ZONE_LOCK. Nothing else is printed, so the caller can capture it.
import './shim'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const { makeKey, sealValue } = await import('../host/code/seal/base')
const { showFile, markDeck } = await import('../host/code/seal/cache')
const { tonePack, toneUnpack } = await import('../host/link/@term/seed/code/tone')

const proj = process.argv[2] as string

// An optional `good` stamp, so a test can build a cache that is already
// stale. The default is far enough out that freshness never interferes with
// a test that is about something else.
const good = (process.argv[3] as string | undefined) ?? '2099-01-01T00:00:00Z'
// Reuse the key the harness already holds, when it has one. Minting a fresh
// key on every call would orphan the cache written by the previous call, so a
// test that rebuilds the cache to change one header would silently be testing
// a cache nobody can open.
const key = process.env.ZONE_LOCK
  ? toneUnpack(process.env.ZONE_LOCK)
  : await makeKey()

const spot = (path: string, root: any): any => {
  let at = root
  for (const seg of path.split('/').slice(1)) {
    let kid = at.zone.find((z: any) => z.name === seg)
    if (!kid) {
      kid = { name: seg, path: `${at.path}/${seg}`, base: '', bind: '', root: false, need: [], cast: [], load: [], lock: [], zone: [] }
      at.zone.push(kid)
    }
    at = kid
  }
  return at
}

const root: any = { name: '', path: 'base', base: '', bind: '', root: false, need: [], cast: [], load: [], lock: [], zone: [] }
for (const [path, name, plain] of [
  ['base', 'database-url', 'postgres://sealed/db'],
  ['base/word.surf/star', 'sentry-dsn', 'https://sealed@sentry'],
] as Array<[string, string, string]>) {
  spot(path, root).lock.push({ name, code: await sealValue(key, path, name, plain) })
}

const deck = await markDeck(readFileSync(`${proj}/zone.tree`, 'utf8'))
const out = `${proj}/.base/@cluesurf/zone`
mkdirSync(out, { recursive: true, mode: 0o700 })
writeFileSync(`${out}/zone.code.tree`, showFile({
  made: '2026-08-27T18:04:11Z',
  good,
  seal: 'aes-256-gcm',
  deck,
  root,
}), { mode: 0o600 })

process.stdout.write(tonePack(key))
