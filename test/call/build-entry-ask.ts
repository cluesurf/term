// ENTRY MODE BUILDS WHAT ITS CALLER ASKS (decision 094 rule 1 of term/self-host/change/001-finish-self-host, item
// term-self-host-001-0495). An entry request of build-graph.tree `build-request` takes four fields beside the file: the
// caller's text (term test's file as its preprocessor rewrote it), compiled as given, the empty text meaning the disk's
// through `buildable`; `env`, the platform emitted for; `keep-program`, the checked program handed back; and `resolve`,
// a resolver in place of the graph's own (term boot's app resolver). A TypeScript caller's ask that leaves them out
// reads as the empty text, false and the graph's resolver.
// Run: npx tsx test/call/build-entry-ask.ts

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectCache } from '@term/call/code/cache-store'

// a draft's emitted module may stand in for the port before it lands (BUILD_GRAPH_MODULE, an absolute path)
const { buildRequest, entryAsk, makeBuildGraph } = (await import(
  process.env.BUILD_GRAPH_MODULE ?? '@term/call/host/port/code/work/build/build-graph'
)) as typeof import('@term/call/host/port/code/work/build/build-graph')

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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'build-entry-ask-')))
process.env.TERM_CACHE_HOME = join(scratch, 'store')
const root = join(scratch, 'project')
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/entry\n  mark <0.0.1>\n`)
const lib = join(root, 'code', 'lib.tree')
const main = join(root, 'code', 'base.tree')
writeFileSync(lib, `task lib-value\n  like number\n  send back, code 7\n`)
writeFileSync(main, `load ./lib\n  find lib-value\n\ntask disk-only\n  like number\n  send back, lib-value()\n`)

type Answer = { form: string; answer: { ok: boolean; problems: unknown[]; result: Record<string, unknown> | undefined } }
const graph = makeBuildGraph(root)
const store = projectCache(root)
const request = (ask: unknown): Answer['answer'] => (buildRequest(graph, ask as never, store) as unknown as Answer).answer
const emitted = (result: Record<string, unknown> | undefined): string =>
  [...((result?.modules as Map<string, { code?: string; text?: string }>) ?? new Map()).values()]
    .map(one => JSON.stringify(one))
    .join('\n')

// the disk's text, as a TypeScript caller asks with no new field at all
const plain = request({ mode: 'entry', file: main, platform: 'node', precomputed: undefined, explain: undefined })
ok('an ask without the new fields builds the disk', plain.ok === true && emitted(plain.result).includes('diskOnly'), JSON.stringify(plain.problems).slice(0, 300))
ok('and hands back no program', plain.result?.program === undefined)

// the caller's text, compiled as given
const text = `load ./lib\n  find lib-value\n\ntask caller-only\n  like number\n  send back, lib-value()\n`
const given = request(entryAsk(main, text))
ok('the caller\'s text is compiled in place of the disk\'s', given.ok === true && emitted(given.result).includes('callerOnly') && !emitted(given.result).includes('diskOnly'), emitted(given.result).slice(0, 300))

// a caller's text that fails: its problems
const broken = request(entryAsk(main, `task broken\n  like number\n  send back, read nowhere-at-all\n`))
ok('a caller\'s text that fails answers not ok', broken.ok === false)
ok('with its diagnostics', ((broken.result as { diagnostics?: unknown[] } | undefined)?.diagnostics?.length ?? 0) > 0)

// keep-program
// (the program is the entry unit's as built THIS request: a text no request built yet)
const kept = request(entryAsk(main, `task kept-only\n  like number\n  send back, code 5\n`, '', true))
ok('keep-program hands back the checked program', kept.ok === true && kept.result?.program !== undefined)

// env: the platform the compiler emits for, which the unit's key holds; the empty text is no env at all
const booted = `task boot\n  like number\n  send back, code 1\n`
const onBrowser = request(entryAsk(main, booted, 'browser'))
const onNone = request(entryAsk(main, booted))
const onEmpty = request(entryAsk(main, booted, ''))
const keyOf = (one: typeof onNone): unknown => one.result?.closureKey
ok('env browser keys the entry otherwise than no env', onBrowser.ok === true && onNone.ok === true && keyOf(onBrowser) !== keyOf(onNone), `${keyOf(onBrowser)} ${keyOf(onNone)}`)
ok('the empty env is no env', keyOf(onEmpty) === keyOf(onNone), `${keyOf(onEmpty)} ${keyOf(onNone)}`)

// a resolver in place of the graph's: every load goes through it
let asked = 0
const resolve = (path: string, from: string): unknown => {
  asked++
  return path === './lib' ? { file: lib, text: `task lib-value\n  like number\n  send back, code 8\n` } : undefined
}
const resolved = request(entryAsk(main, '', '', false, resolve))
ok('a caller\'s resolver is asked for the loads', asked > 0 && resolved.ok === true, `${asked} ${JSON.stringify(resolved.problems).slice(0, 300)}`)

rmSync(scratch, { recursive: true, force: true })
console.log(`\nbuild-entry-ask: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
