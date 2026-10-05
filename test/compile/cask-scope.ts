// The scope matcher (app-scope, deck/cask/code/scope.tree `in-scope`), on every backend a cask runs: TypeScript (the
// WebView's own build), Swift, Kotlin and Rust. Every answer below was worked out by hand from the rules in that file's
// header, never from running it, and the cases are the ways past a scope that matter: `..` climbing out, a name that
// only BEGINS with the scope's folder, a relative path, a home the platform could not give, `*` against `**`.
// SCOPE_ONLY=typescript (or rust, swift, kotlin) runs one backend. Run: npx tsx test/compile/cask-scope.ts

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'

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

const DATA = '/data/app'
const BUNDLE = '/app/res'
const HOME = '/home/p'

// value, patterns (one a line), kind, the home directory, the answer, why, and the data directory when not DATA
type Case = [value: string, patterns: string, kind: 'path' | 'name', home: string, want: boolean, why: string, data?: string]

// a Windows data directory, as the platform answers it
const WINDOWS_DATA = 'C:\\Users\\p\\AppData\\Roaming\\App'

const CASES: Case[] = [
  ['/data/app/notes.db', '$data/**', 'path', HOME, true, 'a file in the data folder'],
  ['/data/app', '$data/**', 'path', HOME, true, '`**` is zero folders too: the data folder itself'],
  ['/data/app/../secret', '$data/**', 'path', HOME, false, '`..` folds to /data/secret, outside'],
  ['/data/app/x/../../app/y', '$data/**', 'path', HOME, true, 'folds to /data/app/y, inside again'],
  ['/data/app/../../../../etc/passwd', '$data/**', 'path', HOME, false, 'climbing past the root stays at the root: /etc/passwd'],
  ['/data/appendix/x', '$data/**', 'path', HOME, false, 'a folder whose name only begins with the data folder\'s'],
  ['data/app/x', '$data/**', 'path', HOME, false, 'a relative path is never in scope'],
  ['/home/p/Documents/a.txt', '$home/Documents/*.txt', 'path', HOME, true, '`*` within one name'],
  ['/home/p/Documents/sub/a.txt', '$home/Documents/*.txt', 'path', HOME, false, '`*` never crosses a folder'],
  ['/home/p/Documents/a.md', '$home/Documents/*.txt', 'path', HOME, false, 'the wrong ending'],
  ['/home/p/x.tar.gz', '$home/*.gz', 'path', HOME, true, 'the ending after a dot inside the name'],
  ['/home/p/ab', '$home/a*b*', 'path', HOME, true, 'pieces may be empty: `a`, then `b`, then anything'],
  ['/home/p/ba', '$home/a*b*', 'path', HOME, false, 'the first piece must begin the name'],
  ['/etc/passwd', '$data/**\n$home/**', 'path', HOME, false, 'two patterns, neither matching'],
  ['/home/p/notes/x', '$data/**\n$home/notes/**', 'path', HOME, true, 'the second of two patterns'],
  ['/a/b/c', '/a/**/c', 'path', HOME, true, '`**` as one folder in the middle'],
  ['/a/c', '/a/**/c', 'path', HOME, true, '`**` as no folder in the middle'],
  ['/a/b/d', '/a/**/c', 'path', HOME, false, 'the name after `**` must still match'],
  ['/app/res/web/index.html', '$bundle/web/*', 'path', HOME, true, 'the bundle variable'],
  ['/x', '$home/**', 'path', '', false, 'a home the platform could not give leaves the pattern relative, matching nothing'],
  ['HOME', 'HOME\nLANG', 'name', HOME, true, 'a listed name'],
  ['PATH', 'HOME\nLANG', 'name', HOME, false, 'an unlisted name'],
  ['ANY', '*', 'name', HOME, true, '`*` is every name'],
  ['*', 'HOME', 'name', HOME, false, 'asking for every name needs `*` in the list'],
  ['C:\\Users\\p\\AppData\\Roaming\\App\\notes.db', '$data/**', 'path', HOME, true, 'a Windows path in a Windows data directory', WINDOWS_DATA],
  ['C:\\Users\\p\\AppData\\Roaming\\App\\..\\Other\\x', '$data/**', 'path', HOME, false, 'a Windows `..` folds out of it', WINDOWS_DATA],
  ['D:/Users/p/AppData/Roaming/App/x', '$data/**', 'path', HOME, false, 'the same folders on another drive', WINDOWS_DATA],
  ['C:relative\\x', '$data/**', 'path', HOME, false, 'a drive with no root after it is relative', WINDOWS_DATA],
]

// a value as a text literal: a backslash is written `\\`
const literal = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')

const call = ([value, patterns, kind, home, , , data]: Case): string => `  save answer
    call in-scope
      text <${literal(value)}>
      text <${literal(patterns)}>
      text <${kind}>
      text <${literal(data ?? DATA)}>
      text <${BUNDLE}>
      text <${home}>
  fork test
    hook test
      read answer
    hook hold
      save out, text <{out}1>
    hook miss
      save out, text <{out}0>`

const PROGRAM = `load @term/cask/scope
  find in-scope

task run
  like text
  save out, text <>
${CASES.map(call).join('\n')}
  send back, read out
`

const want = CASES.map(one => (one[4] ? '1' : '0')).join('')
const dir = mkdtempSync(join(tmpdir(), 'term-cask-scope-'))
const only = process.env.SCOPE_ONLY ?? ''

for (const backend of BACKENDS.filter(one => !only || one === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'scope' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  if (ran.form === 'failed') {
    ok(`${backend}: compiles, builds and runs`, false, `${ran.stage}: ${ran.reason}`)
    continue
  }

  for (const [index, one] of CASES.entries()) {
    ok(`${backend}: ${one[0]} against ${one[1].replace(/\n/g, ' + ')}: ${one[4] ? 'in' : 'out'}, ${one[5]}`, ran.output[index] === want[index], `answered ${ran.output[index]}`)
  }
}

console.log(`\ncask-scope: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
