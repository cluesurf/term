// THE GRADUAL SEAM IS ON BY DEFAULT (note/project/term/decisions-2026-10/seam/, item 0008). With TERM_UNKNOWN_SEAM
// unset, `term make` refuses an `unknown` handed to a typed place. TERM_UNKNOWN_SEAM=0 turns it off (kept so a person
// can bisect without a code change), and =1 still means on. The setting is part of every compile cache key
// (check/strict.ts `checkerSwitchKey`), so an answer stored with the seam off is never read as a seam-on answer.
//
// The switch is read from the environment when check/strict.ts loads, so each setting runs in a child process of this
// same file (`child` as its first argument), which compiles the program and prints what it saw as one JSON line.
// Run: npx tsx test/check/seam-default.ts

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import {
  checkerSwitchKey,
  unknownSeamOn,
} from '@term/make/code/check/strict'
import { tempDir } from '../temp'

// text through an unknown to a task that wants a number
const PROGRAM = `task bump
  take n, like number

  like number

  back add(n, 1)

task pass-through
  take value, like unknown

  like number

  back bump(value)
`

type Seen = {
  on: boolean
  key: string
  messages: string[]
}

if (process.argv[2] === 'child') {
  const dir = tempDir('seam-default-')
  const built = compile(
    { file: join(dir, 'seam.tree'), text: PROGRAM },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  const seen: Seen = {
    on: unknownSeamOn(),
    key: checkerSwitchKey(true, unknownSeamOn()),
    messages: built.ok ? [] : built.diagnostics.map(d => d.message),
  }

  console.log(JSON.stringify(seen))
} else {
  let pass = 0
  let fail = 0

  const ok = (name: string, cond: boolean, info = ''): void => {
    if (cond) {
      pass++
      console.log(`ok    ${name}`)
    } else {
      fail++
      console.log(`FAIL  ${name}  ${info}`)
    }
  }

  // one child per setting: undefined leaves the variable out of the environment altogether
  const run = (value: string | undefined): Seen | string => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.TERM_UNKNOWN_SEAM

    if (value !== undefined) {
      env.TERM_UNKNOWN_SEAM = value
    }

    const child = spawnSync(
      process.execPath,
      [...process.execArgv, process.argv[1]!, 'child'],
      { env, encoding: 'utf8' },
    )
    const line = child.stdout.trim().split('\n').pop() ?? ''

    try {
      return JSON.parse(line) as Seen
    } catch {
      return `exit ${child.status}: ${child.stderr.slice(-400)}`
    }
  }

  const refusal = (seen: Seen): boolean =>
    seen.messages.some(m =>
      m.includes('an unknown value where a number is wanted'),
    )

  const unset = run(undefined)
  const off = run('0')
  const on = run('1')

  if (
    typeof unset === 'string' ||
    typeof off === 'string' ||
    typeof on === 'string'
  ) {
    ok(
      'each setting runs',
      false,
      [unset, off, on].filter(s => typeof s === 'string').join(' | '),
    )
  } else {
    ok('unset: the seam is on', unset.on)
    ok(
      'unset: an unknown handed to a number is refused',
      refusal(unset),
      unset.messages.join(' | '),
    )

    if (refusal(unset)) {
      console.log(
        `      ${unset.messages.find(m => m.includes('an unknown value where'))}`,
      )
    }

    ok('TERM_UNKNOWN_SEAM=0: the seam is off', !off.on)
    ok(
      'TERM_UNKNOWN_SEAM=0: the same program builds',
      off.messages.length === 0,
      off.messages.join(' | '),
    )
    ok('TERM_UNKNOWN_SEAM=1: the seam is on', on.on)
    ok(
      'TERM_UNKNOWN_SEAM=1: the program is refused',
      refusal(on),
      on.messages.join(' | '),
    )
    ok(
      'the cache key differs between unset and =0',
      unset.key !== off.key,
      `${unset.key} / ${off.key}`,
    )
    ok(
      'the cache key carries +seam when on',
      unset.key.includes('+seam') && on.key === unset.key,
      `${unset.key} / ${on.key}`,
    )
    ok(
      'the cache key carries no +seam when off',
      !off.key.includes('+seam'),
      off.key,
    )
  }

  console.log(`\n${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}
