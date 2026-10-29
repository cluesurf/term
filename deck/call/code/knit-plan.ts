// `term knit`, what it decides without the API, a build or the terminal: the price of a request from the usage the API
// reported, the HARD spend cap, the round control, the reading of `term hold`'s output, which files a model may write,
// the gate a run must pass, and the report. Every part here is a plain function of its input, held by
// test/call/knit.ts with no network and no key (note/project/term/assurance/prove-loop).

import path from 'node:path'
import type { LawSentence } from '@term/make/code/check/law-english'

// ---- the price, from the usage the API reported ----

// dollars per million tokens. A 5-minute cache write is 1.25 times input, a 1-hour write 2 times, a read the model's own
// rate (claude-api skill, cached 2026-10-06; shared/prompt-caching.md "Economics")
export type Price = {
  input: number
  output: number
  cacheRead: number
  write5m: number
  write1h: number
}

export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    write5m: 5,
    write1h: 8,
  },
  'claude-opus-5': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    write5m: 6.25,
    write1h: 10,
  },
  'claude-opus-4-8': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    write5m: 6.25,
    write1h: 10,
  },
  'claude-sonnet-5-5': {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    write5m: 2.5,
    write1h: 4,
  },
  'claude-fable-5-1': {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    write5m: 12.5,
    write1h: 20,
  },
}

// the most any listed model charges for each kind of token: what an unlisted model, or a request a fallback model
// served, is priced at, so the cap can only be reached early, never late
export const CEILING: Price = Object.values(PRICES).reduce(
  (top, one) => ({
    input: Math.max(top.input, one.input),
    output: Math.max(top.output, one.output),
    cacheRead: Math.max(top.cacheRead, one.cacheRead),
    write5m: Math.max(top.write5m, one.write5m),
    write1h: Math.max(top.write1h, one.write1h),
  }),
  { input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0 },
)

// the usage fields the Messages API reports, as it spells them
export type Usage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null
    ephemeral_1h_input_tokens?: number | null
  } | null
}

export function priceOf(model: string): Price {
  return PRICES[model] ?? CEILING
}

// what one request cost. A cache write the API did not split by TTL is priced as the dearer 1-hour write
export function costOf(usage: Usage, price: Price): number {
  const n = (value: number | null | undefined): number => value ?? 0
  const written = n(usage.cache_creation_input_tokens)
  const split = usage.cache_creation
  const write5m = split ? n(split.ephemeral_5m_input_tokens) : 0
  const write1h = split ? n(split.ephemeral_1h_input_tokens) : written
  const unsplit = Math.max(0, written - write5m - write1h)

  return (
    (n(usage.input_tokens) * price.input +
      n(usage.output_tokens) * price.output +
      n(usage.cache_read_input_tokens) * price.cacheRead +
      write5m * price.write5m +
      (write1h + unsplit) * price.write1h) /
    1_000_000
  )
}

// the input a request sent, every kind together
export function inputOf(usage: Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

// ---- the cap ----

// what a run has spent, and the last request's input and output: the next request sends both again, as history
export type Spend = {
  dollars: number
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  lastInput: number
  lastOutput: number
}

export function noSpend(): Spend {
  return {
    dollars: 0,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    lastInput: 0,
    lastOutput: 0,
  }
}

export function spend(total: Spend, usage: Usage, price: Price): Spend {
  return {
    dollars: total.dollars + costOf(usage, price),
    requests: total.requests + 1,
    input: total.input + (usage.input_tokens ?? 0),
    output: total.output + (usage.output_tokens ?? 0),
    cacheRead: total.cacheRead + (usage.cache_read_input_tokens ?? 0),
    cacheWrite:
      total.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
    lastInput: inputOf(usage),
    lastOutput: usage.output_tokens ?? 0,
  }
}

// the most the NEXT request can cost: every token of its input unread from the cache and written to it at the 1-hour
// rate (the dearest way in), and every token of `maxTokens` written out. Its input is the last request's, the last
// answer (now history) and `grow`, the tokens the loop added since (tool results, a nudge); the first is `firstInput`
export function worstNext(
  total: Spend,
  input: {
    price: Price
    maxTokens: number
    firstInput: number
    grow: number
  },
): number {
  const sent =
    (total.requests === 0
      ? input.firstInput
      : total.lastInput + total.lastOutput) + input.grow

  return (
    (sent * Math.max(input.price.input, input.price.write1h) +
      input.maxTokens * input.price.output) /
    1_000_000
  )
}

// THE HARD CAP: a request is sent only when what was spent plus the worst the request can cost stays within the cap,
// so a run never spends past it, whatever the model writes
export function mayAsk(
  total: Spend,
  cap: number,
  worst: number,
): boolean {
  return total.dollars + worst <= cap
}

export function dollars(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`
}

// ---- the rounds ----

// a ROUND is one `term hold` the loop runs. A TURN is one request to the model. A run stops at whichever limit comes
// first, and says which
export type Limits = {
  rounds: number
  turns: number
  minutes: number
  cap: number
}

export type Progress = {
  rounds: number
  turns: number
  started: number
  now: number
  spend: Spend
  holds: boolean
  finished: boolean
}

export type Stop =
  | { stop: false }
  | {
      stop: true
      reason:
        | 'holds'
        | 'rounds'
        | 'turns'
        | 'time'
        | 'cap'
        | 'refusal'
        | 'error'
      message: string
    }

export function stopOf(
  progress: Progress,
  limits: Limits,
  worst: number,
): Stop {
  if (progress.finished && progress.holds) {
    return { stop: true, reason: 'holds', message: 'The project holds' }
  }

  if (progress.rounds >= limits.rounds) {
    return {
      stop: true,
      reason: 'rounds',
      message: `Stopped after ${progress.rounds} rounds of term hold, the limit (--rounds)`,
    }
  }

  if (progress.turns >= limits.turns) {
    return {
      stop: true,
      reason: 'turns',
      message: `Stopped after ${progress.turns} requests to the model, the limit (--turns)`,
    }
  }

  if (progress.now - progress.started >= limits.minutes * 60_000) {
    return {
      stop: true,
      reason: 'time',
      message: `Stopped after ${limits.minutes} minutes, the limit (--minutes)`,
    }
  }

  if (!mayAsk(progress.spend, limits.cap, worst)) {
    return {
      stop: true,
      reason: 'cap',
      message: `Stopped at the spend cap: ${dollars(progress.spend.dollars)} spent, and the next request could cost up to ${dollars(worst)}, past the cap of ${dollars(limits.cap)} (--cap)`,
    }
  }

  return { stop: false }
}

// ---- what `term hold --log json --json` printed ----

// one item of the run, as `--log json` writes it, one object per line
export type HoldEvent = {
  glyph?: string
  verb?: string
  subject?: string
  code?: string
  kind?: string
  message?: string
  fields?: Record<string, string>
  counts?: Record<string, number>
}

export type HoldLeanClaim = {
  name: string
  file: string
  verdict: string
  axioms: string[]
  reason?: string
}

// the summary `--json` prints, the parts read here
export type HoldSummary = {
  files: number
  failed: string[]
  open: string[]
  total: number
  proven: number
  fresh: { key: string; message: string }[]
  ledger: {
    native: string[]
    axioms: string[]
    unending: string[]
    roaming: string[]
  }
  kernel: {
    proven: number
    commands: number
    declined: number
    reasons: [string, number][]
  }
  lean?: {
    missing: boolean
    claims: HoldLeanClaim[]
    ok: boolean
    version?: string
  }
  // `term hold --report`'s page (call/code/hold-report.ts), when that build of term hold has it
  report?: {
    page: string
    holds: boolean
    top: string
    laws?: { name: string; holds: boolean; why?: string }[]
  }
}

export type HoldProblem = {
  subject: string
  code?: string
  at?: string
  detail: string[]
}

export type HoldRead = {
  holds: boolean
  summary?: HoldSummary
  problems: HoldProblem[]
  // lines of stdout that were neither an event nor the summary
  stray: number
}

// the summary is the one multi-line block, opened by a line `{` and closed by a line `}`; every other line is an event
export function readHold(stdout: string, exit: number): HoldRead {
  const lines = stdout.split('\n')
  const problems: HoldProblem[] = []

  let summary: HoldSummary | undefined
  let stray = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (line === '{') {
      const end = lines.indexOf('}', i)

      if (end > i) {
        try {
          summary = JSON.parse(
            lines.slice(i, end + 1).join('\n'),
          ) as HoldSummary
        } catch {
          stray += end - i + 1
        }

        i = end
        continue
      }
    }

    if (line.trim() === '') {
      continue
    }

    let event: HoldEvent

    try {
      event = JSON.parse(line) as HoldEvent
    } catch {
      stray++
      continue
    }

    if (event.kind === 'problem' || event.glyph === 'failed') {
      if (event.kind === 'close') {
        continue
      }

      problems.push({
        subject: event.subject ?? '',
        ...(event.code ? { code: event.code } : {}),
        ...(event.fields?.file ? { at: event.fields.file } : {}),
        detail: [
          ...(event.message ? event.message.split('\n') : []),
          ...(event.fields?.next ? [`next: ${event.fields.next}`] : []),
        ],
      })
    }
  }

  return { holds: exit === 0, summary, problems, stray }
}

// ---- the gate a run must pass ----

// `notes`: what a person should read and the gate does not fail on (a lemma Lean declined)
export type Gate = {
  ok: boolean
  reasons: string[]
  notes: string[]
  lean: 'checked' | 'failed' | 'unavailable' | 'off'
}

// one named law against the law library (call/code/knit-law.ts `checkInstances`): whether the project's claim is the
// library's statement with the project's fill, the fill, and why not
export type LawInstance = {
  law: string
  ok: boolean
  file?: string
  fill?: Record<string, string>
  problem?: string
  english?: string
}

// THE GATE: `term hold --lean --report` exits 0 on the project (every file compiles, no claim open, every tier-0
// obligation proven, and under --lean every claim re-checked by Lean with no axiom), it rests on no axiom, every law
// the person named is a claim of the program, Lean checked each of them, and the report's row for each holds. And,
// given `instances`, each named law is the law library's statement filled with the app's own names (the instance
// check). `laws` are the program's rules in words
export function gateOf(input: {
  hold: HoldRead
  laws: LawSentence[]
  required: string[]
  lean: boolean
  instances?: LawInstance[]
}): Gate {
  const reasons: string[] = []
  const notes: string[] = []
  const { hold, laws, required } = input

  for (const instance of input.instances ?? []) {
    if (!instance.ok) {
      reasons.push(
        `${instance.law} is not the law library's ${instance.law}: ${instance.problem ?? 'refused'}`,
      )
    }
  }

  if (!hold.holds) {
    reasons.push(
      `term hold${input.lean ? ' --lean' : ''} --report does not exit 0`,
    )
  }

  for (const row of hold.summary?.report?.laws ?? []) {
    if (required.includes(row.name) && !row.holds) {
      reasons.push(
        `the report says ${row.name} does not hold${row.why ? `: ${row.why}` : ''}`,
      )
    }
  }

  if (!hold.summary) {
    reasons.push('term hold printed no summary')
  } else if (hold.summary.ledger.axioms.length > 0) {
    reasons.push(
      `it rests on axioms: ${hold.summary.ledger.axioms.join(', ')}`,
    )
  }

  for (const name of required) {
    const law = laws.find(one => one.name === name)

    if (!law) {
      reasons.push(`there is no law named ${name}`)
    } else if (law.kind !== 'claim') {
      reasons.push(
        `${name} is a ${law.kind}, not a claim with a proof the kernel keeps`,
      )
    }
  }

  let lean: Gate['lean'] = 'off'

  if (input.lean) {
    const result = hold.summary?.lean

    if (!result) {
      lean = 'unavailable'
    } else if (result.missing) {
      lean = 'unavailable'
      reasons.push('Lean is not installed, so no law was re-checked')
    } else {
      const unchecked = required.filter(name => {
        const claim = result.claims.find(one => one.name === name)

        return (
          claim?.verdict !== 'checked' ||
          claim.axioms.length > 0
        )
      })

      lean = unchecked.length === 0 ? 'checked' : 'failed'

      if (lean === 'failed') {
        reasons.push(
          `Lean did not check ${unchecked
            .map(name => {
              const claim = result.claims.find(one => one.name === name)

              return claim
                ? `${name} (${claim.verdict}${claim.reason ? `: ${claim.reason}` : ''})`
                : `${name} (not exported)`
            })
            .join(', ')}`,
        )
      }

      // the exit already fails on these: named here so the person sees which
      const others = result.claims.filter(
        one =>
          !required.includes(one.name) && one.verdict !== 'checked',
      )

      if (others.length > 0) {
        notes.push(
          `Lean did not check ${others.length} other claim${others.length === 1 ? '' : 's'}: ${others.map(one => `${one.name} (${one.verdict})`).join(', ')}`,
        )
      }
    }
  }

  return { ok: reasons.length === 0, reasons, notes, lean }
}

// ---- what the model may write ----

// a path the model asked to write, inside the project's code/ folder and ending .tree, or the reason it may not
export function codePath(
  root: string,
  asked: string,
): { ok: true; file: string } | { ok: false; reason: string } {
  if (typeof asked !== 'string' || asked.trim() === '') {
    return { ok: false, reason: 'the path is empty' }
  }

  if (path.isAbsolute(asked)) {
    return {
      ok: false,
      reason:
        'the path must be relative to the project, such as code/model.tree',
    }
  }

  const file = path.resolve(root, asked)
  const code = path.join(root, 'code') + path.sep

  if (!file.startsWith(code)) {
    return {
      ok: false,
      reason: 'only files under code/ may be written',
    }
  }

  if (!file.endsWith('.tree')) {
    return { ok: false, reason: 'only .tree files may be written' }
  }

  return { ok: true, file }
}

// ---- what the model is told after a round ----

// the round's result as the model reads it: the verdict, then each problem with the source line it names, at most
// `cap` of them. `lineAt` reads one line of a project file
export function feedbackOf(
  hold: HoldRead,
  input: {
    lineAt: (at: string) => string | undefined
    cap?: number
    gate?: Gate
  },
): string {
  const cap = input.cap ?? 12
  const out: string[] = []

  const problems = `${hold.problems.length} problem${hold.problems.length === 1 ? '' : 's'}`
  out.push(
    hold.holds
      ? 'term hold: HOLDS.'
      : `term hold: DOES NOT HOLD. ${problems}.`,
  )

  for (const problem of hold.problems.slice(0, cap)) {
    out.push('')
    out.push(
      `- ${problem.subject}${problem.code ? ` [${problem.code}]` : ''}`,
    )

    if (problem.at) {
      const line = input.lineAt(problem.at)
      out.push(
        `  at ${problem.at}${line !== undefined ? `: ${line.trim()}` : ''}`,
      )
    }

    for (const detail of problem.detail) {
      out.push(`  ${detail}`)
    }
  }

  if (hold.problems.length > cap) {
    out.push(
      '',
      `(${hold.problems.length - cap} more problems not shown: fix these first)`,
    )
  }

  const summary = hold.summary

  if (summary) {
    out.push(
      '',
      `files: ${summary.files}, failed: ${summary.failed.join(', ') || 'none'}, open claims: ${summary.open.join(', ') || 'none'}, axioms: ${summary.ledger.axioms.join(', ') || 'none'}`,
    )
  }

  if (input.gate && !input.gate.ok) {
    out.push(
      '',
      'The run is not done yet:',
      ...input.gate.reasons.map(reason => `- ${reason}`),
    )
  }

  return out.join('\n')
}

// ---- the report ----

export type KnitResult = {
  name: string
  date: string
  spec: string
  model: string
  verdict: 'holds' | 'stopped'
  stop: string
  rounds: number
  turns: number
  seconds: number
  spend: Spend
  cap: number
  gate: Gate
  laws: LawSentence[]
  required: string[]
  // each named law against the law library
  instances?: LawInstance[]
  summary?: HoldSummary
  emitted: string[]
}

// the one page of a run, the shape of mvp.md "The report", minimal until `term hold` prints its own. Every law is its
// sentence from the Term form (check/law-english.ts), never the model's description
export function reportOf(run: KnitResult): string {
  const s = run.summary
  const out: string[] = []
  // every rule of the program, the laws the person named first: a lemma is a law too, and a person may reject one
  const lawRules = [
    ...run.laws.filter(law => run.required.includes(law.name)),
    ...run.laws.filter(law => !run.required.includes(law.name)),
  ]

  out.push(`${run.name}  ${run.date}  ${run.model}`)
  out.push('')
  out.push(
    run.verdict === 'holds'
      ? `holds: ${run.required.join(', ')}, ${s?.proven ?? 0}/${s?.total ?? 0} obligations, ${run.laws.length} rules in the program`
      : `does not hold: ${run.stop}`,
  )

  if (!run.gate.ok) {
    out.push(...run.gate.reasons.map(reason => `  ${reason}`))
  }

  out.push(...run.gate.notes.map(note => `  note: ${note}`))

  out.push('')
  out.push(
    'the laws, in words from their Term form (approve each before the proof counts):',
  )

  for (const law of lawRules) {
    const status =
      run.verdict === 'holds' ? 'holds' : 'not shown to hold'

    out.push(`  ${law.name}  ${status}`)
    out.push(
      `    ${law.text ?? `(not rendered: ${law.refused ?? 'no sentence'})`}`,
    )

    if (law.words.length > 0) {
      out.push(
        `    names tasks by their own names: ${law.words.join(', ')}`,
      )
    }

    const instance = run.instances?.find(one => one.law === law.name)

    if (instance) {
      out.push(
        instance.ok
          ? `    the law library's ${law.name} (@term/site/law/${law.name}.tree), filled with ${Object.entries(
              instance.fill ?? {},
            )
              .map(([hole, name]) => `${hole} ${name}`)
              .join(', ')}`
          : `    NOT the law library's ${law.name}: ${instance.problem ?? 'refused'}`,
      )
    }
  }

  out.push('')

  if (s) {
    out.push(
      `assumed (each an axiom of the proof): ${s.ledger.axioms.length === 0 ? 'none' : s.ledger.axioms.join(', ')}`,
    )
    out.push(
      `impure tasks (reach native code, nothing proves them): ${s.ledger.native.length}`,
    )
    out.push(
      `not proven: ${s.fresh.length} obligations, ${s.open.length} open claims. declined by the kernel: ${s.kernel.declined} tasks`,
    )
  }

  const lean = run.gate.lean
  const claims = s?.lean?.claims ?? []
  out.push(
    lean === 'off'
      ? 're-checked in Lean 4: not asked (--no-lean)'
      : lean === 'unavailable'
        ? 're-checked in Lean 4: not available in this build of term hold'
        : `re-checked in Lean 4: ${claims.filter(one => one.verdict === 'checked').length} of ${claims.length}`,
  )
  out.push('')
  out.push(
    `rounds of term hold: ${run.rounds}, requests: ${run.turns}, time: ${Math.round(run.seconds)}s`,
  )
  out.push(
    `spent: ${dollars(run.spend.dollars)} of a ${dollars(run.cap)} cap (input ${run.spend.input}, output ${run.spend.output}, cache read ${run.spend.cacheRead}, cache write ${run.spend.cacheWrite} tokens)`,
  )

  if (run.emitted.length > 0) {
    out.push(`emitted TypeScript: ${run.emitted.join(', ')}`)
  }

  if (s?.report?.page) {
    out.push('', 'term hold --report:', '', s.report.page.trimEnd())
  }

  out.push('')
  out.push(
    'These laws hold of this code, assuming what is listed above. The English is what was proven: read it.',
  )

  return out.join('\n') + '\n'
}
