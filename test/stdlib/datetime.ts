// Date / time tests: the `date` (current moment + decomposition), `timezone` (DST-aware wall-clock conversion), and
// `calendar` (format / parse / component / arithmetic) modules, compiled from base.tree and run. date and timezone
// delegate to `calendar` + `time` and one native offset expression per backend (no runtime shim).
// Run: npx tsx test/stdlib/datetime.ts

import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from '@cluesurf/make/code/compile/compile'
import type { Source } from '@cluesurf/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@cluesurf/make/code/compile/native'
import { render } from '@cluesurf/make/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', 'deck', 'base')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/base/'

  if (!path.startsWith(prefix)) {
    return undefined
  }

  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  const prefix = '@cluesurf/base/'

  if (!path.startsWith(prefix)) {
    return undefined
  }

  const file = join(baseTree, path.slice(prefix.length))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

let pass = 0
let fail = 0

function eq(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

async function load(
  file: string,
): Promise<Record<string, (...a: unknown[]) => any>> {
  const text = readFileSync(join(baseTree, 'code', file), 'utf8')
  const result = compile(
    { file: 'main.tree', text },
    { resolve: withNativeEnv('node', stdlib) },
  )

  if (!result.ok) {
    for (const d of result.diagnostics) {
      console.log(render(d, text.split('\n'), false))
    }

    throw new Error(`compile failed: ${file}`)
  }

  const ts =
    nativePrelude(result.program, 'node', readRuntime) +
    '\n' +
    result.typescript
  const dir = mkdtempSync(join(tmpdir(), 'seed-datetime-'))
  const out = join(dir, 'm.ts')
  writeFileSync(out, ts)

  return (await import(pathToFileURL(out).href)) as Record<
    string,
    (...a: unknown[]) => any
  >
}

const SUMMER = Date.UTC(2026, 5, 23, 12, 0, 0) // Jun 23 2026 12:00Z (DST active in EU + US)
const WINTER = Date.UTC(2026, 0, 15, 12, 0, 0) // Jan 15 2026 12:00Z

async function main(): Promise<void> {
  const calendar = await load('calendar.tree')
  const built = calendar.makeUtc(2026, 6, 23, 12, 34, 56) as number
  eq(
    'calendar format/parse round-trips',
    calendar.parse(calendar.format(built)),
    built,
  )
  eq('calendar year of a built instant', calendar.year(built), 2026)
  eq('calendar add-days crosses a month', calendar.day(
    calendar.addDays(calendar.makeUtc(2026, 1, 31, 0, 0, 0), 1),
  ), 1)

  const date = await load('date.tree')
  eq(
    'date current-year is a sane recent year',
    (date.currentYear() as number) >= 2025,
    true,
  )
  eq(
    'date now-text ends with Z (ISO UTC)',
    (date.nowText() as string).endsWith('Z'),
    true,
  )

  const tz = await load('timezone.tree')
  eq('timezone Tokyo is +9h', tz.offsetHours(SUMMER, 'Asia/Tokyo'), 9)
  eq(
    'timezone Paris is +1h in winter, +2h in summer (DST)',
    [tz.offsetHours(WINTER, 'Europe/Paris'), tz.offsetHours(SUMMER, 'Europe/Paris')],
    [1, 2],
  )
  eq(
    'timezone New York is -4h in summer (DST)',
    tz.offsetHours(SUMMER, 'America/New_York'),
    -4,
  )
  eq('timezone UTC offset is 0', tz.offsetHours(SUMMER, 'UTC'), 0)
  eq(
    'timezone local wall-clock hour (12:00Z + 2 = 14:00 Paris)',
    tz.localParts(SUMMER, 'Europe/Paris').hour,
    14,
  )

  console.log(`\ndate / time: ${pass} pass, ${fail} fail`)
}

main()
