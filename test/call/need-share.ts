// Sharing files between installed versions (deck/call/code/need-load.ts `extractShared`, note/term/plan/term-versions.md
// "Disk", V10): a file the release's list gives the same path, sha256 and mode as an installed version's list is
// hard-linked instead of extracted, nothing else is, and removing one version leaves the other whole. Real tarballs in a
// scratch directory, each with the list `pnpm term:release` writes.
// Run: npx tsx test/call/need-share.ts
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractShared, readFileList, writeFileList } from '@term/call/code/need-load'

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

const root = mkdtempSync(join(tmpdir(), 'term-share-'))

// a payload: `term/` with these files and its list, packed as a release packs it
function payload(name: string, files: Record<string, string>, executable: string[] = []): string {
  const stage = join(root, 'stage', name)

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(stage, 'term', path, '..'), { recursive: true })
    writeFileSync(join(stage, 'term', path), text)
    chmodSync(join(stage, 'term', path), executable.includes(path) ? 0o755 : 0o644)
  }

  writeFileList(join(stage, 'term'))

  const archive = join(root, `${name}.tar.gz`)

  execFileSync('tar', ['-czf', archive, '-C', stage, 'term'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

  return archive
}

const common = { 'deck/base/code/list.tree': 'task size\n', 'bin/term': '#!/bin/sh\n' }
const old = payload('old', { ...common, 'host/line.js': 'old cli', 'package.json': '2.6.4', 'deck/base/code/text.tree': 'aaaa', 'bin/tool': 'x' }, ['bin/term'])
const fresh = payload('new', { ...common, 'host/line.js': 'new cli', 'package.json': '2.6.6', 'deck/base/code/text.tree': 'bbbb', 'bin/tool': 'x', 'deck/base/code/time.tree': 'task now\n' }, ['bin/term', 'bin/tool'])

const listed = readFileList(join(root, 'stage', 'new', 'term', 'hash.tree'))
ok('the list names every file once, not itself', listed?.size === 7 && !listed.has('hash.tree'), JSON.stringify([...(listed?.keys() ?? [])]))
ok('   with its sha256 and mode', listed?.get('bin/term')?.mode === '755' && /^[0-9a-f]{64}$/.test(listed?.get('bin/term')?.hash ?? ''))

const oldDir = join(root, 'code', '2.6.4')
const newDir = join(root, 'code', '2.6.6')

mkdirSync(oldDir, { recursive: true })
mkdirSync(newDir, { recursive: true })

const first = await extractShared({ archive: old, into: oldDir, others: [] })
ok('the first version unpacks whole and shares nothing', first.files === 0 && readFileSync(join(oldDir, 'term', 'host', 'line.js'), 'utf8') === 'old cli')

const shared = await extractShared({ archive: fresh, into: newDir, others: [join(oldDir, 'term')] })
const ino = (dir: string, path: string) => statSync(join(dir, 'term', path)).ino

ok('the same file is linked', ino(oldDir, 'deck/base/code/list.tree') === ino(newDir, 'deck/base/code/list.tree'))
ok('   and so is a second one', ino(oldDir, 'bin/term') === ino(newDir, 'bin/term'))
ok('a changed file is not', ino(oldDir, 'host/line.js') !== ino(newDir, 'host/line.js') && readFileSync(join(newDir, 'term', 'host', 'line.js'), 'utf8') === 'new cli')
ok('   nor one of the same size with other bytes', readFileSync(join(newDir, 'term', 'deck', 'base', 'code', 'text.tree'), 'utf8') === 'bbbb')
ok('   nor one with another mode', ino(oldDir, 'bin/tool') !== ino(newDir, 'bin/tool') && (statSync(join(newDir, 'term', 'bin', 'tool')).mode & 0o777) === 0o755)
ok('a file only the new version has is extracted', readFileSync(join(newDir, 'term', 'deck', 'base', 'code', 'time.tree'), 'utf8') === 'task now\n')
ok('the count is the files linked, and their bytes', shared.files === 2 && shared.bytes === 'task size\n'.length + '#!/bin/sh\n'.length, JSON.stringify(shared))
ok('the new version carries its own list', existsSync(join(newDir, 'term', 'hash.tree')))

// a file the old list promises and the disk no longer has is extracted from the archive instead
const third = join(root, 'code', '2.6.8')

mkdirSync(third, { recursive: true })
rmSync(join(oldDir, 'term', 'bin', 'term'))
await extractShared({ archive: fresh, into: third, others: [join(oldDir, 'term')] })
ok('a listed file gone from the disk is extracted instead', readFileSync(join(third, 'term', 'bin', 'term'), 'utf8') === '#!/bin/sh\n')

rmSync(oldDir, { recursive: true, force: true })
ok('removing the old version leaves the new one whole', readFileSync(join(newDir, 'term', 'deck', 'base', 'code', 'list.tree'), 'utf8') === 'task size\n')

console.log(`\nneed-share: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
