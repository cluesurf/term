/**
 * `term knit` - THE PROVE LOOP (note/project/term/assurance/prove-loop). A plain-English spec (and, if given, a
 * TypeScript module to port) goes in. A model writes the Term code, the laws and their proofs into a new project, the
 * loop runs `term hold` on it (with `--lean`, the second checker), hands the model what failed, and repeats until the
 * project holds with every law the person named, or a limit is reached. Out come the Term source, the emitted
 * TypeScript, and a report whose every law is rendered in English from its Term form (check/law-english.ts), never from
 * the model's prose.
 *
 * The model may search; only the kernel decides. The loop never reads a verdict from the model: it runs `term hold`
 * itself, as a child process, and reads its exit code and its `--log json` items.
 *
 * Spend is capped in code (`--cap`, $25): before every request the loop prices the worst that request can cost from the
 * usage the API reported so far, and stops with the reason when it would pass the cap.
 *
 * Nothing about the API is loaded until the loop runs (call/code/knit-model.ts), so `term` starts without the SDK or
 * the key.
 */

import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { lawSentencesOf } from '@term/make/code/check/law-english'
import type { LawSentence } from '@term/make/code/check/law-english'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import {
  closeRun,
  count,
  field,
  openRun,
  report,
} from '@term/call/code/output'
import * as plan from '@term/call/code/knit-plan'
import type {
  Block,
  Message,
  Speaker,
  Tool,
  Turn,
} from '@term/call/code/knit-model'
import {
  checkInstances,
  howToState,
  LIBRARY_MARK,
  libraryLaw,
  libraryNames,
  markLine,
  seal,
} from '@term/call/code/knit-law'
import type { LibraryLaw } from '@term/call/code/knit-law'

export type KnitInput = {
  root: string
  spec: string
  // a TypeScript module to port, its path and text
  port?: { file: string; text: string }
  name: string
  out: string
  required: string[]
  limits: plan.Limits
  lean: boolean
  example: boolean
  model: string
  maxTokens: number
  // the CLI that runs `term hold` and `term make`
  line: string
}

// ---- where things are ----

// the Term package root: this file is deck/call/code/knit.ts in the source and host/line.js once bundled
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))

  for (const up of ['..', '../../..']) {
    const root = path.resolve(here, up)

    if (
      existsSync(path.join(root, 'deck/call/code')) &&
      existsSync(path.join(root, 'test/assurance'))
    ) {
      return root
    }
  }

  return path.resolve(here, '..')
}

export function lineOf(root = packageRoot()): string {
  return path.join(root, 'host/line.js')
}

// the fixed context: the syntax, the proof guide, the demo's traps, and the demo as an example. The same bytes every
// run, so the API serves them from its cache
function contextFiles(
  root: string,
  example: boolean,
): { label: string; file: string }[] {
  // the repository: the Term package is deck/term/deck/term in it
  const repo = path.resolve(root, '../../../..')
  const files = [
    {
      label: 'The Term language: syntax, rules and conventions',
      file: path.join(repo, 'deck/term/CLAUDE.md'),
    },
    {
      label: 'Laws and proofs in Term: claims, theorems, the kernel',
      file: path.join(repo, 'note/project/term/proof/law-and-proof.md'),
    },
    {
      label: 'Traps found while proving the notes demo',
      file: path.join(
        repo,
        'note/project/term/assurance/demo/traps.md',
      ),
    },
  ]

  // the demo whole, every file of its code/, as it stands: law.tree loads the others
  if (example) {
    for (const file of treeFiles(
      path.join(root, 'test/assurance/notes'),
    )) {
      files.push({
        label: `EXAMPLE code/${path.basename(file)} of a project that holds (the notes demo, which states its laws by hand: yours are fused from the library)`,
        file,
      })
    }
  }

  return files
}

const INSTRUCTIONS = `You write Term projects whose laws are proven by Term's kernel. Term is a language written in .tree files.

A person gives you a short spec in English, and perhaps a TypeScript module to port. You write:
- code/model.tree: the forms and the pure tasks of the app (state and events to state, state to what a person is shown)
- code/law.tree: the laws the person names, each from the LAW LIBRARY, their proofs, and the lemmas the proofs need
More files under code/ are allowed. The project's deck.tree and role.tree are written for you: every file under code/ is
LEAN (\`back x\` returns, \`<x>\` is text, a bare word is a variable, \`f(a, b)\` is a call).

Rules:
- Every law the person names is a law of the library: a FIXED Term statement, a template (\`tree <law>-law\`) generic
  over the app's forms and its step or view task. Its text follows the spec. State it in code/law.tree with
  \`fuse <law>-law\` and a \`bind <hole>, <name>\` line under it for every hole, each naming your app's OWN form or task,
  defined in code/model.tree (not in the file that states the law). Prove the claim the fuse makes with
  \`task <law>\`, whose parameters are the claim's in order.
- Never write \`rule <law>\` or the template yourself, and never restate a library law. Before every round the loop
  appends the library's template to the end of the file that fuses it, below the line
  "${LIBRARY_MARK}", and then checks that the claim named <law> is exactly the library's statement with your fill.
  Anything you write below that line is replaced.
- A template reads the app's forms in a fixed shape: its comments name every case and field it reads. Write your forms
  in that shape. Your app may have more forms and tasks than the laws read.
- Every lemma is a CLAIM (a \`rule\` with no \`show\`) with a proof the kernel checks as one term. Never \`base true\` (an
  axiom), never \`mark open\`, never a theorem with \`show\`: only claims reach the Lean 4 re-check.
- Your laws are rendered back into English from their Term form, not from anything you say, and a person approves them.
- Load the forms of model.tree into law.tree, never the other way.

Tools:
- write_file(path, content): write one whole file under code/. Rewrite a file whole to change it.
- hold(): run \`term hold --lean --report\` on the project and read what failed. Each call is one round, and rounds are limited.
- laws(): every rule of the project in English, rendered from its Term form.
The run ends by itself when \`term hold --lean --report\` exits 0 (every file compiles and EVERY claim, lemmas included,
is re-checked by Lean 4), the project rests on no axiom, and every law the person named is the library's statement
filled with the app's own names, a claim that holds. Keep your messages short: write files and call hold.`

export function systemOf(root: string, example: boolean): string {
  const parts = [INSTRUCTIONS]

  for (const { label, file } of contextFiles(root, example)) {
    parts.push(
      `\n\n===== ${label} (${path.basename(file)}) =====\n\n${readFileSync(file, 'utf8')}`,
    )
  }

  return parts.join('')
}

export const TOOLS: Tool[] = [
  {
    name: 'write_file',
    description:
      'Write one whole .tree file under code/ in the project, replacing it if it exists.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative to the project, such as code/law.tree',
        },
        content: { type: 'string', description: 'The whole file' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'hold',
    description:
      'Run term hold --lean on the project: the verdict, and each problem with its place. One round.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'laws',
    description:
      'Every rule of the project in plain English, rendered from its Term form. What the person will read.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
]

export function firstMessage(input: {
  spec: string
  required: string[]
  port?: { file: string; text: string }
  library?: LibraryLaw[]
}): string {
  const out = [`The spec:\n\n${input.spec.trim()}`]

  if (input.required.length > 0) {
    out.push(
      `The person requires these laws of the law library: ${input.required.join(', ')}.`,
    )
  }

  for (const law of input.library ?? []) {
    out.push(
      `===== the library's ${law.name} (@term/site/law/${law.name}.tree), appended by the loop to the file that fuses it =====\n\n${law.text.trimEnd()}\n\n` +
        `State it in code/law.tree as\n\n${howToState(law)}\n\nand prove it with \`task ${law.name}\`.`,
    )
  }

  if (input.port) {
    out.push(
      `The TypeScript module to port (${path.basename(input.port.file)}):\n\n${input.port.text}`,
    )
  }

  out.push('Write the project now.')

  return out.join('\n\n')
}

// ---- the project ----

// the project's frame, written by the loop and never by the model: the manifest, the lean role, and laws.tree, which
// names the laws the person asked for so `term hold --report` reports each (call/code/hold-report.ts)
export function scaffold(
  project: string,
  name: string,
  required: string[],
): void {
  mkdirSync(path.join(project, 'code'), { recursive: true })
  writeFileSync(
    path.join(project, 'deck.tree'),
    `deck @knit/${name}\n  head <Written by term knit>\n  mark <0.0.0>\n  lock mit\n`,
  )
  writeFileSync(
    path.join(project, 'role.tree'),
    '# every file here is lean\nrole code\n  mark lean\n  take @/code/*.tree\n',
  )

  if (required.length > 0) {
    writeFileSync(
      path.join(project, 'laws.tree'),
      [
        'list law',
        ...required.flatMap(law => [
          '  mesh',
          `    host name, <${law}>`,
          `    host rule, <${law}>`,
        ]),
      ].join('\n') + '\n',
    )
  }
}

function treeFiles(project: string): string[] {
  const code = path.join(project, 'code')

  if (!existsSync(code)) {
    return []
  }

  return readdirSync(code)
    .filter(name => name.endsWith('.tree'))
    .sort()
    .map(name => path.join(code, name))
}

// every rule of the project in words, from its Term form
export function lawsOf(project: string): {
  laws: LawSentence[]
  errors: string[]
} {
  const roleOf = projectRoleOf(project)
  const leanOf = projectLeanOf(project)
  const laws: LawSentence[] = []
  const errors: string[] = []

  for (const file of treeFiles(project)) {
    const read = lawSentencesOf({
      file,
      text: readFileSync(file, 'utf8'),
      role: roleOf(file) ?? undefined,
      lean: leanOf(file),
    })

    if (read.ok) {
      laws.push(...read.laws)
    } else {
      errors.push(`${path.relative(project, file)}: ${read.error}`)
    }
  }

  return { laws, errors }
}

function lawsText(project: string): string {
  const { laws, errors } = lawsOf(project)
  const lines = laws.map(
    law =>
      `- ${law.name} (${law.kind}): ${law.text ?? `not rendered, ${law.refused}`}`,
  )

  return [
    ...(lines.length ? lines : ['(no rule yet)']),
    ...errors.map(error => `could not read ${error}`),
  ].join('\n')
}

export type Round = { hold: plan.HoldRead; seconds: number }

// `term hold` on the project, as a child process: its exit decides, its items are read for the model
export function runHold(
  line: string,
  project: string,
  lean: boolean,
): Round {
  const started = Date.now()
  const run = spawnSync(
    process.execPath,
    [
      line,
      'hold',
      '--log',
      'json',
      '--json',
      '--report',
      ...(lean ? ['--lean'] : []),
    ],
    {
      cwd: project,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  )

  const exit = run.status ?? 1
  const hold = plan.readHold(run.stdout ?? '', exit)

  if (run.error || (exit !== 0 && hold.problems.length === 0)) {
    hold.problems.push({
      subject: run.error
        ? `term hold did not run: ${run.error.message}`
        : `term hold exited ${exit}`,
      detail: (run.stderr ?? '').split('\n').slice(-20),
    })
  }

  return { hold, seconds: (Date.now() - started) / 1000 }
}

function lineAtOf(project: string): (at: string) => string | undefined {
  return at => {
    const found = /^(.*?):(\d+)(?::\d+)?$/.exec(at)

    if (!found) {
      return undefined
    }

    try {
      const text = readFileSync(
        path.resolve(project, found[1]!),
        'utf8',
      )

      const line = text.split('\n')[Number(found[2]) - 1]
      const mark = markLine(text)

      // a line under the marker is the library's own text: what fails there is the app's forms against its shape
      return line !== undefined &&
        mark !== undefined &&
        Number(found[2]) > mark
        ? `${line.trim()}   (the library's text, appended by the loop: your forms must have the shape it reads)`
        : line
    } catch {
      return undefined
    }
  }
}

// `term make` on a project that holds, and the TypeScript it emitted
function emit(line: string, project: string): string[] {
  spawnSync(process.execPath, [line, 'make'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 600_000,
  })

  const host = path.join(project, 'host')
  const found: string[] = []

  const walk = (dir: string): void => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const file = path.join(dir, name)

      if (statSync(file).isDirectory()) {
        walk(file)
      } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        found.push(path.relative(project, file))
      }
    }
  }

  walk(host)

  return found.sort()
}

// ---- the loop ----

export type Transcript = {
  turns: {
    turn: number
    stop: string
    model: string
    fellBack: boolean
    cost: number
    usage: plan.Usage
    tools: string[]
    said: string
  }[]
  rounds: {
    round: number
    holds: boolean
    problems: number
    first: string[]
    seconds: number
    gate?: string[]
  }[]
}

type ToolUse = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

function textOf(content: Block[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n')
    .trim()
}

const chars = (value: unknown): number =>
  typeof value === 'string'
    ? value.length
    : JSON.stringify(value ?? '').length

export async function knitLoop(
  input: KnitInput,
  speaker: Speaker,
  say: (line: string) => void = () => {},
): Promise<{
  result: plan.KnitResult
  transcript: Transcript
  messages: Message[]
}> {
  const project = path.join(input.out, 'project')
  scaffold(project, input.name, input.required)

  const started = Date.now()
  const root = packageRoot()
  const system = systemOf(root, input.example)
  // the whole library, which the seal appends wherever a file fuses one of its laws, and the laws the person named,
  // which the instance check holds the project to: a name the library lacks is refused there
  const library = libraryNames(root).flatMap(
    name => libraryLaw(root, name) ?? [],
  )

  const named = input.required.flatMap(name =>
    library.filter(law => law.name === name),
  )

  const messages: Message[] = [
    {
      role: 'user',
      content: firstMessage({ ...input, library: named }),
    },
  ]

  let instances: plan.LawInstance[] = []

  const check = (): plan.LawInstance[] =>
    checkInstances({
      project,
      required: input.required,
      laws: library,
      roleOf: projectRoleOf(project),
      leanOf: projectLeanOf(project),
    })

  const transcript: Transcript = { turns: [], rounds: [] }
  const price = plan.priceOf(input.model)

  let total = plan.noSpend()
  let rounds = 0
  let turns = 0
  let grow = 0
  let gate: plan.Gate = {
    ok: false,
    reasons: ['term hold has not run'],
    notes: [],
    lean: input.lean ? 'unavailable' : 'off',
  }

  let last: plan.HoldRead | undefined
  let finished = false
  let stop: plan.Stop = { stop: false }

  // one round of `term hold`, and the gate on it
  const round = (): string => {
    rounds++
    // the library's text under the marker of every file that fuses a law, before term hold reads the project
    seal(project, library)

    const { hold, seconds } = runHold(input.line, project, input.lean)
    const { laws } = lawsOf(project)
    last = hold
    instances = check()
    // a build of term hold with no --lean yet prints no `lean`: the gate is then what term hold says, and the report
    // says Lean did not run (plan.gateOf, `unavailable`)
    gate = plan.gateOf({
      hold,
      laws,
      required: input.required,
      lean: input.lean,
      instances,
    })
    finished = gate.ok
    transcript.rounds.push({
      round: rounds,
      holds: hold.holds,
      problems: hold.problems.length,
      first: hold.problems.slice(0, 3).map(p => p.subject),
      seconds,
      ...(gate.ok ? {} : { gate: gate.reasons }),
    })
    say(
      `round ${rounds}: ${hold.holds ? 'holds' : `${hold.problems.length} problems`}${gate.ok ? ', the gate passes' : ''}`,
    )

    return plan.feedbackOf(hold, { lineAt: lineAtOf(project), gate })
  }

  while (true) {
    // tokens counted as half the characters, more than Term source or English ever take, so the worst is never low
    const worst = plan.worstNext(total, {
      price: input.model in plan.PRICES ? price : plan.CEILING,
      maxTokens: input.maxTokens,
      firstInput: Math.ceil(chars(system) / 2) + 2000,
      grow: Math.ceil(grow / 2),
    })

    stop = plan.stopOf(
      {
        rounds,
        turns,
        started,
        now: Date.now(),
        spend: total,
        holds: gate.ok,
        finished,
      },
      input.limits,
      worst,
    )

    if (stop.stop) {
      break
    }

    turns++

    let turn: Turn

    try {
      turn = await speaker.ask({ system, tools: TOOLS, messages })
    } catch (error) {
      // what a stream that broke partway was billed still counts. Such a request is asked again, after the cap is
      // checked again at the top of the loop; any other failure stops the run
      const broken = (error as { broken?: plan.Usage[] }).broken ?? []

      for (const usage of broken) {
        total = plan.spend(total, usage, plan.CEILING)
      }

      const said =
        error instanceof Error ? error.message : String(error)

      transcript.turns.push({
        turn: turns,
        stop: 'error',
        model: input.model,
        fellBack: false,
        cost: broken.reduce(
          (sum, usage) => sum + plan.costOf(usage, plan.CEILING),
          0,
        ),
        usage: broken[0] ?? {},
        tools: [],
        said: said.slice(0, 400),
      })
      say(`turn ${turns}: the request failed: ${said.slice(0, 200)}`)

      if (broken.length > 0) {
        continue
      }

      stop = {
        stop: true,
        reason: 'error',
        message: `The request to the model failed: ${said}`,
      }
      break
    }

    // attempts that broke partway were billed too, at the dearest rates since the model that served them is unknown
    for (const usage of turn.broken ?? []) {
      total = plan.spend(total, usage, plan.CEILING)
    }

    const turnPrice =
      turn.fellBack || !(turn.model in plan.PRICES)
        ? plan.CEILING
        : plan.priceOf(turn.model)

    const cost = plan.costOf(turn.usage, turnPrice)
    total = plan.spend(total, turn.usage, turnPrice)
    grow = 0
    messages.push({ role: 'assistant', content: turn.content })

    const uses = turn.content.filter(
      (block): block is Block & ToolUse => block.type === 'tool_use',
    )

    transcript.turns.push({
      turn: turns,
      stop: turn.stopReason,
      model: turn.model,
      fellBack: turn.fellBack,
      cost,
      usage: turn.usage,
      tools: uses.map(use =>
        use.name === 'write_file'
          ? `write_file ${String(use.input?.path ?? '')}`
          : use.name,
      ),
      said: textOf(turn.content).slice(0, 400),
    })
    say(
      `turn ${turns}: ${uses.map(use => use.name).join(', ') || turn.stopReason}, ${plan.dollars(total.dollars)} so far`,
    )

    if (turn.stopReason === 'refusal') {
      stop = {
        stop: true,
        reason: 'refusal',
        message: `The model declined: ${turn.refusal ?? ''}`,
      }
      break
    }

    if (uses.length === 0) {
      const nudge =
        'Continue: write the files with write_file and call hold. The run ends when term hold holds with the required laws.'

      messages.push({ role: 'user', content: nudge })
      grow += nudge.length
      continue
    }

    const results: Block[] = []

    for (const use of uses) {
      let text: string
      let error = false

      if (turn.stopReason === 'max_tokens') {
        text =
          'Your turn was cut off at the output limit, so this call was not run. Write one file per write_file call.'
        error = true
      } else if (use.name === 'write_file') {
        const asked =
          typeof use.input?.path === 'string' ? use.input.path : ''

        const content = use.input?.content
        const where = plan.codePath(project, asked)

        if (!where.ok) {
          text = `Not written: ${where.reason}.`
          error = true
        } else if (typeof content !== 'string') {
          text = 'Not written: content must be the whole file as text.'
          error = true
        } else {
          mkdirSync(path.dirname(where.file), { recursive: true })
          writeFileSync(where.file, content)
          text = `Wrote ${asked}, ${content.split('\n').length} lines.`
        }
      } else if (use.name === 'hold') {
        text = round()
      } else if (use.name === 'laws') {
        seal(project, library)
        text = lawsText(project)
      } else {
        text = `There is no tool named ${use.name}.`
        error = true
      }

      grow += text.length
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: text,
        ...(error ? { is_error: true } : {}),
      })
    }

    messages.push({ role: 'user', content: results })
  }

  const seconds = (Date.now() - started) / 1000
  // the project as it is left: sealed, and each named law checked against the library once more
  seal(project, library)
  instances = check()

  const { laws } = lawsOf(project)
  const holds = stop.stop && stop.reason === 'holds'
  const emitted = holds ? emit(input.line, project) : []

  const result: plan.KnitResult = {
    name: input.name,
    date: new Date(started).toISOString(),
    spec: input.spec,
    model: input.model,
    verdict: holds ? 'holds' : 'stopped',
    stop: stop.stop ? stop.message : '',
    rounds,
    turns,
    seconds,
    spend: total,
    cap: input.limits.cap,
    gate,
    laws,
    required: input.required,
    instances,
    ...(last?.summary ? { summary: last.summary } : {}),
    emitted,
  }

  return { result, transcript, messages }
}

// ---- the command ----

export async function callKnit(input: {
  root: string
  spec?: string
  specFile?: string
  port?: string
  name?: string
  out?: string
  laws?: string[]
  model: string
  effort: string
  cap: number
  rounds: number
  turns: number
  minutes: number
  lean: boolean
  example: boolean
  maxTokens: number
}): Promise<void> {
  const spec = input.specFile
    ? readFileSync(path.resolve(input.root, input.specFile), 'utf8')
    : (input.spec ?? '')

  const name =
    input.name ??
    `knit-${new Date().toISOString().replace(/[:.]/g, '-')}`

  const out = path.resolve(
    input.root,
    input.out ?? path.join('tmp', 'knit', name),
  )

  openRun({
    verb: 'knit',
    root: input.root,
    subject: name,
    facts: [input.model, `cap ${plan.dollars(input.cap)}`],
  })

  if (spec.trim() === '') {
    report({
      glyph: 'failed',
      kind: 'problem',
      subject: 'There is no spec',
      message: ['Give one in words, or --spec-file <file>.'],
    })
    process.exit(
      closeRun({ verdict: 'Nothing to knit', failure: 'usage' }),
    )
  }

  // every --law names a law of the library
  const known = libraryNames(packageRoot())
  const strange = (input.laws ?? []).filter(
    name => !libraryLaw(packageRoot(), name),
  )

  if (strange.length > 0) {
    report({
      glyph: 'failed',
      kind: 'problem',
      subject: `The law library has no law named ${strange.join(', ')}`,
      message: [
        `--law names a law of the library (deck/site/code/law): ${known.join(', ') || 'none'}.`,
      ],
    })
    process.exit(
      closeRun({ verdict: 'Nothing to knit', failure: 'usage' }),
    )
  }

  if (existsSync(path.join(out, 'project'))) {
    report({
      glyph: 'failed',
      kind: 'problem',
      subject: `${out} already holds a run`,
      message: [
        'A run never overwrites another. Name this one with --name.',
      ],
    })
    process.exit(
      closeRun({ verdict: 'Nothing was run', failure: 'usage' }),
    )
  }

  // the API, loaded only now
  const { claudeSpeaker, KnitSetup } =
    await import('@term/call/code/knit-model')

  let speaker: Speaker

  try {
    speaker = await claudeSpeaker({
      model: input.model,
      effort: input.effort,
      maxTokens: input.maxTokens,
    })
  } catch (error) {
    if (error instanceof KnitSetup) {
      report({
        glyph: 'failed',
        kind: 'problem',
        subject: error.message,
        fields: [field('next', error.next)],
      })
      process.exit(
        closeRun({
          verdict: 'The loop did not start',
          failure: 'environment',
        }),
      )
    }

    throw error
  }

  mkdirSync(out, { recursive: true })

  const port = input.port
    ? {
        file: input.port,
        text: readFileSync(
          path.resolve(input.root, input.port),
          'utf8',
        ),
      }
    : undefined

  const { result, transcript, messages } = await knitLoop(
    {
      root: input.root,
      spec,
      ...(port ? { port } : {}),
      name,
      out,
      required: input.laws ?? [],
      limits: {
        rounds: input.rounds,
        turns: input.turns,
        minutes: input.minutes,
        cap: input.cap,
      },
      lean: input.lean,
      example: input.example,
      model: input.model,
      maxTokens: input.maxTokens,
      line: lineOf(),
    },
    speaker,
    line => report({ glyph: 'info', verb: 'knit', subject: line }),
  )

  writeRun(out, result, transcript, messages)

  for (const law of result.laws.filter(one =>
    result.required.includes(one.name),
  )) {
    report({
      glyph: result.verdict === 'holds' ? 'done' : 'info',
      verb: 'law',
      subject: law.name,
      message: [law.text ?? `not rendered: ${law.refused ?? ''}`],
    })
  }

  report({
    glyph: 'info',
    verb: 'knit',
    subject: 'Written',
    fields: [
      field('report', path.join(out, 'report.txt')),
      field('project', path.join(out, 'project')),
    ],
    counts: [
      count(result.rounds, 'rounds', 'round'),
      count(result.turns, 'requests', 'request'),
    ],
  })

  process.exit(
    closeRun({
      verdict: result.verdict === 'holds' ? 'Holds' : 'Does not hold',
      facts: [
        `${plan.dollars(result.spend.dollars)} spent`,
        `${Math.round(result.seconds)}s`,
      ],
      ...(result.verdict === 'holds'
        ? {}
        : { message: [result.stop, ...result.gate.reasons] }),
    }),
  )
}

// the run on disk: the report, the run's data, the transcript summary, and the whole conversation
export function writeRun(
  out: string,
  result: plan.KnitResult,
  transcript: Transcript,
  messages: Message[],
): void {
  writeFileSync(path.join(out, 'report.txt'), plan.reportOf(result))
  writeFileSync(
    path.join(out, 'run.json'),
    JSON.stringify(result, null, 2) + '\n',
  )
  writeFileSync(
    path.join(out, 'transcript.json'),
    JSON.stringify(transcript, null, 2) + '\n',
  )
  writeFileSync(
    path.join(out, 'conversation.json'),
    JSON.stringify(messages, null, 2) + '\n',
  )
}
