// `seed mind`: the project's durable memory -- one fact per file under `.seed/memory/`, with an index. This is what
// lets an unattended session (a disposable agent) start cold and still know the project's decisions and conventions.
//
//   seed mind <fact>            remember a fact
//   seed mind                   list every remembered fact
//   seed mind --find <query>    recall the facts matching a query
//
// The store is plain markdown (a human or any agent can read it); `--back json` returns structured records.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { logGood, fade, logStep } from '@cluesurf/make/code/tint'

const KINDS = ['decision', 'convention', 'constraint', 'reference', 'note']

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'fact'
  )
}

function memoryDir(root: string): string {
  return path.join(root, '.seed', 'memory')
}

type Fact = {
  name: string
  kind: string
  description: string
  body: string
  file: string
}

function readFact(file: string): Fact {
  const text = readFileSync(file, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  const meta = (key: string): string =>
    new RegExp(`^${key}:\\s*(.*)$`, 'm')
      .exec(match?.[1] ?? '')?.[1]
      ?.trim() ?? ''

  return {
    name: meta('name') || path.basename(file, '.md'),
    kind: meta('kind') || 'note',
    description: meta('description'),
    body: (match?.[2] ?? text).trim(),
    file,
  }
}

function allFacts(root: string): Fact[] {
  const dir = memoryDir(root)

  if (!existsSync(dir)) {
    return []
  }

  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'index.md')
    .map(f => readFact(path.join(dir, f)))
}

function remember(
  root: string,
  fact: string,
  nameArg: string | undefined,
  kindArg: string | undefined,
): { name: string; kind: string; file: string } {
  const dir = memoryDir(root)
  mkdirSync(dir, { recursive: true })

  const kind = kindArg && KINDS.includes(kindArg) ? kindArg : 'note'
  const name = slug(nameArg ?? fact)
  const description = fact.split('\n')[0]!.slice(0, 100)
  const file = path.join(dir, `${name}.md`)

  writeFileSync(
    file,
    `---\nname: ${name}\nkind: ${kind}\ndescription: ${description}\n---\n\n${fact}\n`,
  )

  // keep a one-line index, deduped by name (the index is the thing a session loads up front)
  const indexPath = path.join(dir, 'index.md')
  const head = '# Memory\n\n'
  const existing = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8')
    : head
  const kept = existing
    .split('\n')
    .filter(l => l.trim() && !l.startsWith(`- [${name}]`) && l !== '# Memory')
  writeFileSync(
    indexPath,
    `${head}${[...kept, `- [${name}](${name}.md) — ${description}`].join(
      '\n',
    )}\n`,
  )

  return { name, kind, file: path.relative(root, file) }
}

export async function callMind(input: {
  root: string
  fact?: string
  name?: string
  kind?: string
  find?: string
  back?: string
}): Promise<void> {
  const json = input.back === 'json'

  // remember
  if (input.fact) {
    const saved = remember(
      input.root,
      input.fact,
      input.name,
      input.kind,
    )

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...saved })}\n`)
    } else {
      logGood(`remembered ${saved.name} (${saved.kind})`)
    }

    return
  }

  // recall / list
  const query = (input.find ?? '').toLowerCase()
  const facts = allFacts(input.root).filter(
    f =>
      !query ||
      `${f.name} ${f.description} ${f.body}`
        .toLowerCase()
        .includes(query),
  )

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        facts: facts.map(f => ({
          name: f.name,
          kind: f.kind,
          description: f.description,
          body: f.body,
          file: path.relative(input.root, f.file),
        })),
      })}\n`,
    )

    return
  }

  if (!facts.length) {
    console.log(
      fade(
        query ? `  no memories match "${input.find}"` : '  no memories yet',
      ),
    )

    return
  }

  logStep(`Memory (${facts.length})`)

  for (const f of facts) {
    console.log(`  ${f.name} ${fade(`(${f.kind})`)} — ${f.description}`)
  }
}
