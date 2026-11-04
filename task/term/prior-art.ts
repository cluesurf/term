// `pnpm term:prior-art`: note/project/term/term-3/prior-art.md written from prior-art.json, the systems to take apart
// before Term's 3.0 APIs settle. The JSON is the source. Edit it, then run this.
//
//   pnpm term:prior-art            write prior-art.md from prior-art.json
//   pnpm term:prior-art --check    also fetch every source and name one that no longer answers, or that moved

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parentRoot } from './root'

const DIR = (): string => path.resolve(parentRoot(), 'note/term/term-3')

// the generic agent this repository sends to a host that has not asked for ours (mesh/task/dataset/agent.ts)
const AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

type Project = { name: string; source: string; at?: string; key?: boolean; study: string }
type Area = { area: string; title: string; plan: string; projects: Project[] }

// the ★ designs, one line per area, in the order the owner named them on 2026-10-05
const FIRST: [string, string][] = [
  ['serialization', 'Serde'],
  ['async', 'Tokio, Swift and Kotlin structured concurrency'],
  ['web', 'Hono, Axum and Tower'],
  ['database', 'Drizzle, Kysely and SQLx'],
  ['jobs', 'Temporal and Oban'],
  ['i18n', 'ICU4X and Fluent'],
  ['build and package', 'Cargo, Zig and Nix'],
  ['observability', 'Rust tracing and OpenTelemetry'],
  ['headless UI', 'Radix, React Aria and Zag'],
  ['graphics', 'Skia, Vello and Lyon'],
  ['verification', 'Lean (with Mathlib), Z3 and cvc5, TLA+ and Alloy'],
]

function page(areas: Area[]): string {
  const projects = areas.flatMap(area => area.projects)
  const keys = projects.filter(one => one.key).length
  const sources = new Set(projects.map(one => one.source)).size
  const head = [
    '# Prior art to take apart before 3.0',
    '',
    `The systems to read before Term's 3.0 APIs settle, by area: ${projects.length}`,
    `entries over ${areas.length} areas, ${sources} distinct sources. Each is`,
    'here for an API or an architecture to learn from, not as a dependency.',
    `The **${keys} marked ★** are the designs most worth taking apart first.`,
    '',
    'The same list is [prior-art.json](prior-art.json), as data, so a later',
    'task can clone every source. This page is written from it by',
    '`pnpm term:prior-art`, and `pnpm term:prior-art --check` fetches every',
    'source. Every one answered on 2026-10-05, after four GitHub moves were',
    'followed to their current homes (`prisma/orm`, `transact-rs/sqlx`,',
    '`react/jsx`, `react/react-native`).',
    '',
    '## The ★ designs, one line each',
    '',
    'table:',
    '| area | study first |',
    '| --- | --- |',
    ...FIRST.map(([area, first]) => `| ${area} | ${first} |`),
    '',
  ]
  const sections = areas.map(area => {
    const plans = area.plan
      .split(', ')
      .map(plan => `[${plan}](${plan})`)
      .join(', ')
    const rows = area.projects.map(one => {
      const name = one.key ? `**${one.name}** ★` : one.name
      const at = one.at ? ` (${one.at})` : ''

      return `| ${name} | [${one.source.replace(/^https:\/\//, '')}](${one.source})${at} | ${one.study} |`
    })

    return [`## ${area.title}`, '', `The plan: ${plans}.`, '', 'table:', '| project | source | study |', '| --- | --- | --- |', ...rows, ''].join('\n')
  })

  return `${head.join('\n')}\n${sections.join('\n')}`
}

async function check(areas: Area[]): Promise<number> {
  const sources = [...new Set(areas.flatMap(area => area.projects.map(one => one.source)))]
  let bad = 0

  const one = async (url: string): Promise<void> => {
    try {
      const response = await fetch(url, { headers: { 'user-agent': AGENT }, redirect: 'follow' })
      const moved = /github\.com/.test(url) && response.url.replace(/\/$/, '') !== url.replace(/\/$/, '')

      if (!response.ok || moved) {
        bad++
        console.log(`${response.status}  ${url}${moved ? `  now ${response.url}` : ''}`)
      }
    } catch (error) {
      bad++
      console.log(`unreachable  ${url}  ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (let at = 0; at < sources.length; at += 8) {
    await Promise.all(sources.slice(at, at + 8).map(one))
  }

  console.log(`${sources.length} sources checked, ${bad} to fix in prior-art.json`)

  return bad
}

async function main(): Promise<void> {
  const areas = (JSON.parse(readFileSync(path.join(DIR(), 'prior-art.json'), 'utf8')) as { areas: Area[] }).areas

  writeFileSync(path.join(DIR(), 'prior-art.md'), page(areas))
  console.log(`wrote note/project/term/term-3/prior-art.md: ${areas.flatMap(area => area.projects).length} entries, ${areas.length} areas`)

  if (process.argv.includes('--check') && (await check(areas)) > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
