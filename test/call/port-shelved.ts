// port-build shelves a module by a `mark draft` line ANYWHERE in it, as the build walk does (term-self-host-001-0296,
// traps.md T-0294 of term/self-host/change/001-finish-self-host). Its reading, task/port-shelved.ts, answers what
// deck/call/code/draft.ts answers on every case below, port-build reads the marker only through it, and every shelved
// compiler `.tree` of the working tree is shelved by both.
//
//   npx tsx test/call/port-shelved.ts      (from deck/term/deck/term)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { shelvedText } from '../../task/port-shelved'
import { declaresDraft } from '@term/call/code/draft'

let failed = 0

function ok(name: string, cond: boolean, info = ''): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !info ? '' : `: ${info}`}`)

  if (!cond) {
    failed++
  }
}

const header = `# ${'a long header comment line, '.repeat(4)}\n`.repeat(30)

const cases: { name: string; text: string; shelved: boolean }[] = [
  { name: 'marker on line 1', text: 'mark draft\n\ntask a\n', shelved: true },
  { name: 'marker past the first 2000 characters', text: `${header}\nmark draft\n\ntask a\n`, shelved: true },
  { name: 'the old spelling, past 2000 characters', text: `${header}note draft\n`, shelved: true },
  { name: 'a trailing space after the marker', text: 'mark draft  \ntask a\n', shelved: true },
  { name: 'no marker', text: `${header}task a\n`, shelved: false },
  { name: 'an indented marker belongs to its definition', text: 'task a\n  mark draft\n', shelved: false },
  { name: 'a marker inside a comment', text: '# mark draft\ntask a\n', shelved: false },
  { name: 'more after the marker word', text: 'mark draft now\n', shelved: false },
  { name: 'empty text', text: '', shelved: false },
]

for (const one of cases) {
  ok(`${one.name}: port-build reads ${one.shelved ? 'shelved' : 'built'}`, shelvedText(one.text) === one.shelved)
  ok(`${one.name}: the build walk agrees`, declaresDraft(one.text) === shelvedText(one.text))
}

// port-build reads the marker only through shelvedText, never a slice of the text
const portBuild = readFileSync(join(import.meta.dirname, '../../task/port-build.ts'), 'utf8')
ok('port-build imports shelvedText', /import \{ shelvedText \} from '\.\/port-shelved'/.test(portBuild))
ok('port-build tests no marker itself', !/\(mark\|note\) draft/.test(portBuild), 'a pattern of its own is left')
ok('port-build reads no 2000-character slice', !/slice\(0, 2000\)/.test(portBuild))

// every compiler .tree the build walk shelves, port-build shelves too, and the other way round
const root = join(import.meta.dirname, '../../deck/make/code')
let seen = 0
let disagree = 0

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)

    if (statSync(full).isDirectory()) {
      walk(full)
    } else if (name.endsWith('.tree')) {
      const text = readFileSync(full, 'utf8')
      seen++

      if (declaresDraft(text) !== shelvedText(text)) {
        disagree++
        console.log(`  disagrees: ${full}`)
      }
    }
  }
}

walk(root)
ok(`deck/make/code: the ${seen} .tree files read alike`, seen > 0 && disagree === 0, `${disagree} disagree`)

console.log(failed === 0 ? 'PASS' : `FAIL ${failed}`)
process.exit(failed === 0 ? 0 : 1)
