// `gitSource` (call/code/host.ts): the repository address `term host` writes as `org.opencontainers.image.source`,
// which is what links a GHCR package to its repository. It is written into a public manifest, so a credential in an
// https remote must never survive. Run: npx tsx test/call/git-source.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitSource } from '@term/call/code/host'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// a fresh repository in the system temp directory, with `origin` set when one is given
function repo(remote?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'term-git-source-'))

  execFileSync('git', ['init', '-q', dir])

  if (remote) {
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote])
  }

  return dir
}

const CASES: [string, string][] = [
  ['git@github.com:cluesurf/zone.git', 'https://github.com/cluesurf/zone'],
  ['git@github.com:cluesurf/zone', 'https://github.com/cluesurf/zone'],
  ['ssh://git@github.com/cluesurf/zone.git', 'https://github.com/cluesurf/zone'],
  ['https://github.com/cluesurf/zone.git', 'https://github.com/cluesurf/zone'],
  ['https://x-access-token:ghp_secret@github.com/cluesurf/zone.git', 'https://github.com/cluesurf/zone'],
]

for (const [remote, source] of CASES) {
  const found = gitSource(repo(remote))
  ok(`${remote} reads as ${source}`, found === source, String(found))
}

ok('no origin is undefined', gitSource(repo()) === undefined)
ok('outside a repository is undefined', gitSource(mkdtempSync(join(tmpdir(), 'term-git-source-none-'))) === undefined)

console.log(`\ngit-source: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
