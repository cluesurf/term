// node-json writes an optional number field (`need false`, absent reads 0) only when it is not 0, as it leaves out every
// other optional field holding its default (decision 044 part 3, task/term/node-json-gen.ts `writeField`): `place-row`,
// the first such field, on an expression and a statement, and a skip list naming it leaves it out whatever it holds.
// Run: npx tsx test/compile/node-json-number.ts

import { expressionJson, statementJson } from '@term/make/code/compile/node-json'

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

const span = { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } }
const literal = (placeRow?: number): any => ({ form: 'string', value: 'a 😀', span, ...(placeRow === undefined ? {} : { placeRow }) })

const absent = expressionJson([], literal())
ok('an absent place-row is left out', !absent.includes('placeRow'), absent)
const zero = expressionJson([], literal(0))
ok('a place-row of 0 is left out, the same text as absent', zero === absent, zero)
const three = expressionJson([], literal(3))
ok('a place-row of 3 is written as a number, last as node.tree declares it', three.endsWith(',"placeRow":3}'), three)
ok('a skip list naming placeRow leaves it out', expressionJson(['placeRow'], literal(3)) === absent)

const statement = (placeRow?: number): any => ({ form: 'expression', expr: literal(7), span, ...(placeRow === undefined ? {} : { placeRow }) })
const statementText = statementJson([], statement(12))
ok('a statement writes its own place-row and its expression\'s', statementText.includes('"placeRow":7}') && statementText.endsWith(',"placeRow":12}'), statementText)
ok('skipped at every depth', !statementJson(['placeRow'], statement(12)).includes('placeRow'))

console.log(`\nnode-json-number: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
