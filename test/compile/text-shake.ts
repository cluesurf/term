// The text runtime is shaken by method (compile/typescript.ts `textPrelude`): a module carries the methods its code
// names, the methods those call, and the helpers any of them mention. Every method reached from all of them is the
// whole runtime as written, so splitting it loses nothing, and a module that only trims carries `trim` and its two
// whitespace patterns alone.
// Run: npx tsx test/compile/text-shake.ts

import { transformSync } from 'esbuild'
import { TEXT_PRELUDE, textPrelude } from '@term/make/code/compile/typescript'

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

const functionsOf = (code: string): string[] => [...code.matchAll(/^function __termText_(\w+)\(/gm)].map(found => found[1]!)
const methods = [...TEXT_PRELUDE.matchAll(/^ {2}(\w+)\(/gm)].map(found => found[1]!)
const every = textPrelude(methods.map(name => `__termText_${name}(x)`).join('\n'))

ok('every method named gives every method, as a function', functionsOf(every).join(',') === methods.join(','), functionsOf(every).join(','))
ok('the runtime has its methods', methods.length > 25, String(methods.length))
ok('and no object left to call through', !every.includes('__termText.') && !every.includes('const __termText ='))

const trim = textPrelude('const said = __termText_trim(who)')
ok('a trim carries trim', functionsOf(trim).join(',') === 'trim', trim)
ok('and the whitespace it strips', trim.includes('const __termWhite =') && trim.includes('__termWhiteStart') && trim.includes('__termWhiteEnd'))
ok('marked pure, so a bundle that drops trim drops them', trim.includes('const __termWhiteStart = /* @__PURE__ */ (() => new RegExp'))
ok('and no surrogate cache, which trim never reads', !trim.includes('__termSurrogate'))

const at = textPrelude('__termText_charCodeAt(s, 1)')
const atMethods = functionsOf(at)
ok('a method keeps what it calls: charCodeAt reads charAt', atMethods.join(',') === 'charAt,charCodeAt', atMethods.join(','))
ok('and the surrogate cache charAt reads', at.includes('const __termSurrogate ='))
ok('and none of the whitespace', !at.includes('__termWhite'))

const js = transformSync(`${at}\nreturn __termText_charCodeAt("a𝄞b", 1)`, { loader: 'ts' }).code
const runs = new Function(js)() as number
ok('the shaken runtime still runs, counting code points', runs === 0x1d11e, String(runs))

// every method together, each called, so a method whose split lost a line fails here rather than in a program
const all = transformSync(
  `${every}\nreturn [__termText_length("a𝄞b"), __termText_trim("  x "), __termText_substring("a𝄞bc", 1, 3), __termText_padStart("7", 3, "0"), __termText_compare("a", "b"), __termText_indexOf("a𝄞b", "b")].join("|")`,
  { loader: 'ts' },
).code
const answer = new Function(all)() as string
ok('the whole runtime runs', answer === '3|x|𝄞b|007|-1|2', answer)

// a bundle keeps only what its program reaches: trim's whitespace patterns go with trim
const bundled = transformSync(`${trim}\nexport const unused = 1`, { loader: 'ts', treeShaking: true, format: 'esm' }).code
ok('a bundler drops trim and its patterns when nothing calls trim', !bundled.includes('RegExp') && !bundled.includes('__termText_trim'), bundled)

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
