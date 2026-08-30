import { makeStreamingTextCursor, makeTextCursor } from './host/code/base'
import { readJson, readJsonStream, writeJson } from './host/code/json/code'

function source(value: string, width: number) {
  let at = 0
  return () => {
    if (at >= Array.from(value).length) return { form: 'none' } as any
    const chunk = value.substring(at, at + width)
    at += width
    return { form: 'some', value: chunk } as any
  }
}

const cases: [string, number][] = [
  ['{"alpha":1}', 3],
  ['-3.5', 1],
  ['"abc"', 2],
  ['{"a":[1,2,3]}', 1],
]
for (const [text, width] of cases) {
  try {
    const got = writeJson(readJsonStream(makeStreamingTextCursor(source(text, width)) as any))
    const want = writeJson(readJson(text))
    console.log(JSON.stringify(text), 'w=' + width, '->', JSON.stringify(got), got === want ? 'OK' : `MISMATCH want ${JSON.stringify(want)}`)
  } catch (e) {
    console.log(JSON.stringify(text), 'w=' + width, '-> THREW', String((e as Error).message))
  }
}
