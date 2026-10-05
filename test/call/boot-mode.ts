// `term boot [mode] [entry]`: the development server is `term boot`, and production is `term boot star`. `moon`, `dev`
// and `development` are development, the default, and `star`, `prod` and `production` are production. A first word
// that is none of the six is the entry, so `term boot app.tree` still boots that file. `term feed`, which was the
// browser development server, refuses and names `term boot`.
// Run: npx tsx test/call/boot-mode.ts

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootMode } from '@term/call/code/boot'

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

for (const word of ['moon', 'dev', 'development']) {
  const read = bootMode(word, 'app.tree')
  ok(`${word} is development, and the next word the entry`, read.mode === 'development' && read.entry === 'app.tree', JSON.stringify(read))
}

for (const word of ['star', 'prod', 'production']) {
  const read = bootMode(word, 'app.tree')
  ok(`${word} is production, and the next word the entry`, read.mode === 'production' && read.entry === 'app.tree', JSON.stringify(read))
}

ok('a first word that is no mode is the entry', JSON.stringify(bootMode('app.tree')) === JSON.stringify({ entry: 'app.tree' }))
ok('nothing names neither', bootMode().mode === undefined && bootMode().entry === undefined)
ok('a mode alone names no entry', bootMode('star').mode === 'production' && bootMode('star').entry === undefined)

// the command itself, through the built CLI: a command-line program booted into a folder, in each mode
const line = join(import.meta.dirname, '..', '..', 'host', 'line.js')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'boot-mode-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/boot-mode\n  mark <0.0.2>\n  boot ./code/base.tree\n`)
writeFileSync(join(root, 'code', 'base.tree'), `# run at ${Date.now()}\n\n# Answer three\nhook say\n  task answer\n\ntask answer\n  like number\n  back 3\n`)

const boot = (words: string[]): { status: number | null; text: string } => {
  const run = spawnSync('node', [line, 'boot', ...words, '--out', join(root, 'out')], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: '' } })

  return { status: run.status, text: `${run.stdout}${run.stderr}` }
}

const plain = boot([])
ok('a bare term boot is development', plain.status === 0 && /development/.test(plain.text), plain.text)

for (const word of ['moon', 'dev', 'development']) {
  const run = boot([word])
  ok(`term boot ${word} is development`, run.status === 0 && /development/.test(run.text), run.text)
}

for (const word of ['star', 'prod', 'production']) {
  const run = boot([word])
  ok(`term boot ${word} is production`, run.status === 0 && /production/.test(run.text), run.text)
}

const named = boot(['star', join(root, 'code', 'base.tree')])
ok('a mode and an entry boot that entry in that mode', named.status === 0 && /production/.test(named.text), named.text)

const entryFirst = boot([join(root, 'code', 'base.tree')])
ok('an entry alone boots it in development', entryFirst.status === 0 && /development/.test(entryFirst.text), entryFirst.text)

const feed = spawnSync('node', [line, 'feed'], { cwd: root, encoding: 'utf8' })
const feedText = `${feed.stdout}${feed.stderr}`
ok('term feed starts nothing, exit 2', feed.status === 2, `${feed.status} ${feedText}`)
ok('and names term boot', /term boot/.test(feedText), feedText)

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
