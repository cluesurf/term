// Lockfile tests: parse the resolved-graph format and round-trip it deterministically. Run: npx tsx test/deck/lock.ts

import { parseLockfile, serializeLockfile } from '@/code/deck/lock'

const SAMPLE = `base <0.0.1>

load @termsurf/wolf
  mark <*>
  lock <0.0.1>

link <@termsurf/wolf:0.0.1>
  hash <sha512-abc>
  load @termsurf/note
    mark <0.0.1>
`

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${g}, want ${w})`)
  }
}

function main(): void {
  const lock = parseLockfile(SAMPLE)
  expect('base version', lock.base, '0.0.1')
  expect('one request', lock.requests.length, 1)
  expect('request parsed', lock.requests[0], { name: '@termsurf/wolf', range: '*', locked: '0.0.1' })
  expect('one link', lock.links.length, 1)
  expect('link ref', lock.links[0]?.ref, '@termsurf/wolf:0.0.1')
  expect('link hash', lock.links[0]?.hash, 'sha512-abc')
  expect('link dep', lock.links[0]?.deps[0], { name: '@termsurf/note', version: '0.0.1' })

  // deterministic round-trip: serialize -> parse -> serialize is stable
  const once = serializeLockfile(lock)
  const twice = serializeLockfile(parseLockfile(once))
  expect('round-trip is stable', once, twice)

  // deterministic ordering: unsorted input serializes the same as sorted
  const shuffled = {
    base: '0.0.1',
    requests: [
      { name: '@a/z', range: '*', locked: '1.0.0' },
      { name: '@a/a', range: '*', locked: '2.0.0' },
    ],
    links: [],
  }
  const sorted = {
    base: '0.0.1',
    requests: [
      { name: '@a/a', range: '*', locked: '2.0.0' },
      { name: '@a/z', range: '*', locked: '1.0.0' },
    ],
    links: [],
  }
  expect('ordering is deterministic', serializeLockfile(shuffled), serializeLockfile(sorted))

  console.log(`\nlock: ${pass} pass, ${fail} fail`)
}

main()
