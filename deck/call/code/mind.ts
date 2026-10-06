// `term mind`: the project's durable memory -- one fact per file under `.base/@term/code/memory/`, with an index. This is what
// lets an unattended session (a disposable agent) start cold and still know the project's decisions and conventions.
//
//   term mind <fact>            remember a fact
//   term mind                   list every remembered fact
//   term mind --find <query>    recall the facts matching a query
//   term mind --forget <name>   forget one fact, its file and its line in the index
//
// The store is plain markdown (a human or any agent can read it); `--back json` returns structured records.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { closeRun, count, field, location, openRun, printData, report } from '@term/call/code/output'
import { keptAt, projectHome, legacyProjectHome } from '@term/call/code/home'
// what `term mind` decides beside its files: a fact's name and kind, how its file reads and is written, the index,
// which facts a query recalls
import * as words from '@term/call/code/mind-words'

function slug(text: string): string {
  return words.factSlug(text)
}

// the project's memory, which is the one thing here a person WROTE. If a project still has its facts at the
// pre-2026-08-30 path, they are read and written there rather than abandoned. See keptAt.
function memoryDir(root: string): string {
  return keptAt(
    projectHome(root, 'memory'),
    legacyProjectHome(root, 'memory'),
  )
}

type Fact = {
  name: string
  kind: string
  description: string
  body: string
  file: string
}

function readFact(file: string): Fact {
  return { ...words.factOf(readFileSync(file, 'utf8'), path.basename(file, '.md')), file }
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
): { name: string; kind: string; file: string; replaced?: string } {
  const dir = memoryDir(root)
  mkdirSync(dir, { recursive: true })

  const kind = words.factKind(kindArg ?? '')
  const name = slug(nameArg ?? fact)
  const description = fact.split('\n')[0]!.slice(0, 100)
  const file = path.join(dir, `${name}.md`)
  // the fact this one replaces, so the run says it changed one rather than added one
  const replaced = existsSync(file) ? readFact(file).description : undefined

  writeFileSync(file, words.factText(name, kind, description, fact))

  // keep a one-line index, deduped by name (the index is the thing a session loads up front)
  const indexPath = path.join(dir, 'index.md')
  const existing = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : ''

  writeFileSync(indexPath, words.indexWith(existing, name, description))

  return { name, kind, file: path.relative(root, file), ...(replaced !== undefined ? { replaced } : {}) }
}

// forget one fact: its file, and its line in the index. Answers what it forgot, or undefined for a name never used
function forget(root: string, name: string): Fact | undefined {
  const dir = memoryDir(root)
  const file = path.join(dir, `${slug(name)}.md`)

  if (!existsSync(file)) {
    return undefined
  }

  const fact = readFact(file)
  rmSync(file)

  const indexPath = path.join(dir, 'index.md')

  if (existsSync(indexPath)) {
    writeFileSync(indexPath, words.indexWithout(readFileSync(indexPath, 'utf8'), fact.name))
  }

  return fact
}

export async function callMind(input: {
  root: string
  fact?: string
  name?: string
  kind?: string
  find?: string
  forget?: string
  back?: string
}): Promise<void> {
  const json = input.back === 'json'

  // forget
  if (input.forget !== undefined) {
    const gone = forget(input.root, input.forget)

    if (json) {
      printData(`${JSON.stringify(gone ? { ok: true, name: gone.name } : { ok: false, name: input.forget })}\n`)
      process.exitCode = gone ? 0 : 1

      return
    }

    openRun({ verb: 'mind', root: input.root })

    if (gone) {
      report({ glyph: 'removed', kind: 'change', verb: 'remove', subject: gone.name, facts: [gone.kind, gone.description] })
      closeRun({ verdict: 'Forgotten', done: true })
    } else {
      report({ glyph: 'failed', kind: 'problem', subject: `There is no fact named ${input.forget}` })
      closeRun({ verdict: 'Nothing forgotten', next: 'term mind, to list the names' })
    }

    return
  }

  // remember
  if (input.fact) {
    const saved = remember(
      input.root,
      input.fact,
      input.name,
      input.kind,
    )

    if (json) {
      printData(`${JSON.stringify({ ok: true, ...saved })}\n`)
    } else {
      openRun({ verb: 'mind', root: input.root })

      // a name already used replaces its fact: a `change` naming what it was, never an `add` like a new one
      if (saved.replaced !== undefined) {
        report({ glyph: 'changed', kind: 'change', verb: 'change', subject: saved.name, facts: [saved.kind, `was: ${saved.replaced}`], fields: [location(saved.file)] })
      } else {
        report({ glyph: 'added', kind: 'change', verb: 'add', subject: saved.name, facts: [saved.kind], fields: [location(saved.file)] })
      }

      closeRun({ verdict: saved.replaced !== undefined ? 'Replaced' : 'Remembered' })
    }

    return
  }

  // recall / list
  const query = (input.find ?? '').toLowerCase()
  const facts = allFacts(input.root).filter(f => words.recalls(query, f))

  if (json) {
    printData(
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

  // each fact one `recall` item: its description as the subject, its kind and name as facts
  openRun({ verb: 'mind', root: input.root, facts: input.find ? [input.find] : [] })

  for (const f of facts) {
    report({ glyph: 'info', verb: 'recall', subject: f.description || f.name, facts: [f.kind, f.name] })
  }

  closeRun({
    verdict: words.recallVerdict(facts.length, query),
    counts: [count(facts.length, 'facts', 'fact')],
  })
}
