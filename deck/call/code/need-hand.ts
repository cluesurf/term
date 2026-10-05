// The slow half of dispatch (note/term/plan/term-versions.md, "Dispatch"): what `host/need.mjs` imports only when a
// command cannot simply run, built on its own to `host/need-hand.mjs` so the fast half stays a few kilobytes.
//
// Two jobs, both printed through the terminal output library like every other command's lines:
//
//   load    install the version resolution asked for, verified (need-load.ts), with one `load` item and its signer
//   refuse  say why nothing ran, in one sentence naming the fix, and exit non-zero
//
// It never runs the command itself. `need-run.ts` does that, in this process or the chosen version's.

import { loadVersion, sharedFacts } from '@term/call/code/need-load'
import type { NeedChoice } from '@term/call/code/need'
import { closeRun, field, openRun, report, setOutput, showPath, type OutputFlags } from '@term/call/code/output'

/** Install what a `load` choice names. The version on success, or undefined once the refusal is printed. */
export async function loadNeeded(input: {
  choice: Extract<NeedChoice, { form: 'load' }>
  running: string
  local: boolean
  argv: string[]
}): Promise<string | undefined> {
  const { choice } = input
  const asked = choice.version ?? choice.request.text

  setOutput(outputFlags(input.argv), input.running)
  openRun({ verb: 'need', root: process.cwd(), subject: `term ${asked}`, facts: [whereFrom(choice.request)] })

  if (input.local) {
    report({
      glyph: 'failed',
      kind: 'problem',
      verb: 'need',
      subject: `${whoNeeds(choice.request)} needs term ${asked} and none is installed, and TERM_NEED=local forbids a download`,
    })
    closeRun({ verdict: 'Nothing ran', failure: 'environment', next: `term self load ${asked}` })

    return undefined
  }

  const loaded = await loadVersion({ version: choice.version, hold: choice.hold, expect: choice.expect })

  if (!loaded.ok) {
    report({ glyph: 'failed', kind: 'problem', verb: 'load', subject: loaded.reason })
    closeRun({ verdict: 'Nothing ran', failure: 'environment' })

    return undefined
  }

  report({
    glyph: 'done',
    verb: 'load',
    subject: `term ${loaded.version} for ${loaded.platform}`,
    duration: loaded.duration,
    bytes: loaded.bytes || undefined,
    facts: sharedFacts(loaded.shared),
    fields: loaded.fresh ? [field('layer', loaded.layer), field('signed', loaded.keys)] : [],
  })
  closeRun({ verdict: `Running term ${loaded.version}`, done: true })

  return loaded.version
}

/** Print why nothing ran. */
export function refuseNeed(input: { reason: string; running: string; usage?: boolean; argv: string[] }): void {
  setOutput(outputFlags(input.argv), input.running)
  openRun({ verb: 'need', root: process.cwd() })
  report({ glyph: 'failed', kind: 'problem', verb: 'need', subject: input.reason })
  closeRun({ verdict: 'Nothing ran', failure: input.usage ? 'usage' : 'environment' })
}

// `deck.tree:3`, `TERM_VERSION`, `+2.6.x`: where the request was written
function whereFrom(request: Extract<NeedChoice, { form: 'load' }>['request']): string {
  switch (request.source) {
    case 'flag':
      return `+${request.text}`
    case 'env':
      return `TERM_VERSION=${request.text}`
    default:
      return request.file ? `${showPath(request.file)}:${request.line ?? 1}` : request.source
  }
}

function whoNeeds(request: Extract<NeedChoice, { form: 'load' }>['request']): string {
  switch (request.source) {
    case 'project':
      return 'This project'
    case 'default':
      return 'The default (term self pick)'
    case 'env':
      return 'TERM_VERSION'
    default:
      return 'This command'
  }
}

// The global output flags the command was given (output.ts `OutputFlags`), so what dispatch prints before the command
// runs looks like what the command prints after it. Read from the arguments by name, because yargs is in line.js and
// this runs before it. A flag dispatch does not print through is left to the command
function outputFlags(argv: string[]): OutputFlags {
  const flags: OutputFlags = {}
  const valueOf = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`)
    const joined = argv.find(one => one.startsWith(`--${name}=`))

    return joined ? joined.slice(name.length + 3) : at >= 0 ? argv[at + 1] : undefined
  }

  for (const name of ['quiet', 'verbose', 'trace', 'utc', 'plain', 'strict', 'raw'] as const) {
    if (argv.includes(`--${name}`)) {
      flags[name] = true
    }
  }

  if (argv.includes('--no-motion')) {
    flags.motion = false
  }

  flags.color = valueOf('color')
  flags.log = valueOf('log')

  return flags
}
