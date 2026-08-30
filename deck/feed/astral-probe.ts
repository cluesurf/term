import { readJson, writeJson } from './host/code/json/code'
const cases = ['{"a":"\u{1F600}\u{1F680}b","b":1}', '"\u{1F600}"', '"a\u{1F600}b"', '{"a":1}']
for (const input of cases) {
  try {
    const out = writeJson(readJson(input))
    console.log(JSON.stringify(input), '->', JSON.stringify(out), out === input ? 'OK' : 'MISMATCH')
  } catch (e) { console.log(JSON.stringify(input), '-> THREW', String((e as Error).message)) }
}
