// `term knit`, the prove loop, without the API (call/code/knit-plan.ts, call/code/knit.ts,
// note/project/term/assurance/prove-loop). Run: npx tsx test/call/knit.ts
//
// What it holds, with no network and no key:
//   - THE PRICE. A request's dollars from the usage the API reports: input, output, cache reads, and cache writes by
//     TTL, an unsplit write at the dearer 1-hour rate, an unknown or fallback model at the ceiling of the table
//   - THE CAP. A request is sent only when spent plus the worst it can cost stays within the cap, and a run whose
//     requests are huge stops with the cap's reason having spent no more than the cap
//   - THE ROUNDS. The loop stops on the first of: holds, rounds, turns, minutes, the cap
//   - READING TERM HOLD. `--log json --json` output (captured from a real refusal and a real pass) to its verdict,
//     problems and summary, a stray line counted and never fatal
//   - THE GATE. Holds, no axiom, every named law a claim, and under --lean each named law checked by Lean
//   - WHAT A MODEL MAY WRITE. Only .tree files under code/
//   - THE LAW LIBRARY (call/code/knit-law.ts, deck/site/code/law/). Each law a template; the seal appends it below the
//     marker and undoes any edit there; THE INSTANCE CHECK passes the library fixture (test/assurance/library) and
//     refuses run-4-no-example's isolation, the delete policy restated by hand (test/call/knit-fixture/restated), the
//     same in a template of the library's name, a hole bound to a task beside the law, a hole left out, a law fused
//     twice or not at all. No term hold and no API here
//   - THE LOOP, END TO END, with a scripted model: run-4's project, which holds under the real `term hold` and is refused
//     by the instance check with the fuse to write, then the library fixture, which holds with each law an instance; the
//     laws in the report are the renderer's English
//   - THE COMMAND. `term knit` with no spec is a usage error, and without a key it stops before any request, naming the
//     zone that holds it; `term` itself starts without the SDK

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import * as plan from '@term/call/code/knit-plan'
import { codePath } from '@term/call/code/knit-plan'
import {
  firstMessage,
  knitLoop,
  lineOf,
  packageRoot,
  systemOf,
  TOOLS,
} from '@term/call/code/knit'
import {
  checkInstances,
  LIBRARY_MARK,
  libraryLaw,
  libraryNames,
  ownText,
  seal,
  sealed,
} from '@term/call/code/knit-law'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { bodyOf, KnitRequest } from '@term/call/code/knit-model'
import type { Block, Speaker, Turn } from '@term/call/code/knit-model'
import {
  applyStreamEvent,
  MessageRequestError,
  streamMessage,
} from '../../../../../make/code/code/api-client'
import type { StreamedMessage } from '../../../../../make/code/code/api-client'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
// each folder under tmp/knit-test is removed when the test ends (term-cli-in-term-0177)
import { removeAtExit } from '../temp'

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

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

// ---- the price ----

const opus = plan.priceOf('claude-opus-5-5')
ok(
  'a million input tokens of Opus 5.5 cost $4',
  near(plan.costOf({ input_tokens: 1_000_000 }, opus), 4),
)
ok(
  'a million output tokens cost $20',
  near(plan.costOf({ output_tokens: 1_000_000 }, opus), 20),
)
ok(
  'a million cache reads cost $0.20',
  near(plan.costOf({ cache_read_input_tokens: 1_000_000 }, opus), 0.2),
)
ok(
  'a cache write split by TTL is priced by TTL',
  near(
    plan.costOf(
      {
        cache_creation_input_tokens: 2_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      },
      opus,
    ),
    5 + 8,
  ),
)
ok(
  'a cache write the API did not split is priced at the 1-hour rate',
  near(
    plan.costOf({ cache_creation_input_tokens: 1_000_000 }, opus),
    8,
  ),
)
ok(
  'every kind of token adds up',
  near(
    plan.costOf(
      {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 40_000,
        cache_creation: { ephemeral_1h_input_tokens: 40_000 },
      },
      opus,
    ),
    (1000 * 4 + 2000 * 20 + 30_000 * 0.2 + 40_000 * 8) / 1e6,
  ),
)
ok(
  'null fields read as none',
  plan.costOf(
    { input_tokens: null, output_tokens: null, cache_creation: null },
    opus,
  ) === 0,
)
ok(
  'an unknown model is priced at the ceiling of the table',
  plan.priceOf('claude-future-9').output === plan.CEILING.output &&
    plan.CEILING.output >= 50,
)
ok(
  'dollars print to four places under one, two above',
  plan.dollars(0.01234) === '$0.0123' &&
    plan.dollars(12.5) === '$12.50',
)

// ---- the cap ----

let spent = plan.noSpend()
spent = plan.spend(
  spent,
  { input_tokens: 10_000, output_tokens: 5000 },
  opus,
)
ok(
  'spend sums dollars and tokens and keeps the last request',
  near(spent.dollars, (10_000 * 4 + 5000 * 20) / 1e6) &&
    spent.requests === 1 &&
    spent.lastInput === 10_000 &&
    spent.lastOutput === 5000,
)
const worst = plan.worstNext(spent, {
  price: opus,
  maxTokens: 64_000,
  firstInput: 1,
  grow: 1000,
})
ok(
  'the worst next request resends the last input and answer, at the dearest input rate, and writes every output token',
  near(worst, ((10_000 + 5000 + 1000) * 8 + 64_000 * 20) / 1e6),
  String(worst),
)
ok(
  'the first request is priced from the first input',
  near(
    plan.worstNext(plan.noSpend(), {
      price: opus,
      maxTokens: 100,
      firstInput: 1000,
      grow: 0,
    }),
    (1000 * 8 + 100 * 20) / 1e6,
  ),
)
ok(
  'a request that fits is asked',
  plan.mayAsk({ ...plan.noSpend(), dollars: 20 }, 25, 5),
)
ok(
  'a request that could pass the cap is not',
  !plan.mayAsk({ ...plan.noSpend(), dollars: 20 }, 25, 5.01),
)

// ---- the rounds ----

const limits: plan.Limits = {
  rounds: 3,
  turns: 5,
  minutes: 60,
  cap: 25,
}
const at = (over: Partial<plan.Progress>): plan.Progress => ({
  rounds: 0,
  turns: 0,
  started: 0,
  now: 0,
  spend: plan.noSpend(),
  holds: false,
  finished: false,
  ...over,
})
const reason = (s: plan.Stop): string => (s.stop ? s.reason : 'go')
ok(
  'a fresh run goes on',
  reason(plan.stopOf(at({}), limits, 1)) === 'go',
)
ok(
  'a run that holds stops as holding',
  reason(
    plan.stopOf(
      at({ holds: true, finished: true, rounds: 3, turns: 5 }),
      limits,
      1,
    ),
  ) === 'holds',
)
ok(
  'the round limit stops it',
  reason(plan.stopOf(at({ rounds: 3 }), limits, 1)) === 'rounds',
)
ok(
  'the turn limit stops it',
  reason(plan.stopOf(at({ turns: 5 }), limits, 1)) === 'turns',
)
ok(
  'the time limit stops it',
  reason(plan.stopOf(at({ now: 60 * 60_000 }), limits, 1)) === 'time',
)
const capped = plan.stopOf(
  at({ spend: { ...plan.noSpend(), dollars: 24.5 } }),
  limits,
  1,
)
ok(
  'the cap stops it, and the message names what was spent and the cap',
  reason(capped) === 'cap' &&
    capped.stop &&
    /\$24\.50 spent/.test(capped.message) &&
    /\$25\.00/.test(capped.message),
  capped.stop ? capped.message : '',
)

// ---- reading term hold ----

// captured from `term hold --log json --json` on test/assurance/twin/isolation (2026-10-21), the summary trimmed
const REFUSED = [
  '{"glyph":"info","verb":"hold","subject":"~/x/broken","counts":{"files":1},"facts":["term 2.7.4"],"kind":"open"}',
  '{"glyph":"failed","verb":"prove","subject":"The proof of `isolation` does not check against its claim, so it proves nothing: type mismatch:","code":"unverified-proof","message":"expected ((owned ((person w) (rank doer))) shown)\\nfound    ((owned doer) shown)","fields":{"file":"code/law.tree:543:1","next":"the type the claim states is printed over the type the proof builds. Change the proof, or the claim"},"kind":"problem"}',
  '{',
  '  "files": 1,',
  '  "failed": ["code/law.tree"],',
  '  "open": [],',
  '  "total": 0,',
  '  "proven": 0,',
  '  "fresh": [],',
  '  "ledger": { "native": [], "axioms": [], "unending": [], "roaming": [] },',
  '  "kernel": { "proven": 0, "commands": 0, "declined": 0, "reasons": [] }',
  '}',
  '{"glyph":"info","verb":"trust","subject":"What the proofs rest on and nothing here proves","kind":"step"}',
  '{"glyph":"failed","verb":"hold","subject":"Does not hold","counts":{"files_do_not_hold":1},"kind":"close"}',
].join('\n')

const refused = plan.readHold(REFUSED, 1)
ok('a refusal reads as not holding', !refused.holds)
ok(
  'its one problem, with subject, code and place, and the closing item is no problem',
  refused.problems.length === 1 &&
    refused.problems[0]!.code === 'unverified-proof' &&
    refused.problems[0]!.at === 'code/law.tree:543:1',
  JSON.stringify(refused.problems),
)
ok(
  'the problem keeps the expected and found types and the next step',
  refused.problems[0]!.detail.length === 3 &&
    refused.problems[0]!.detail[2]!.startsWith('next: '),
)
ok(
  'the summary is read from its block',
  refused.summary?.failed[0] === 'code/law.tree' &&
    refused.summary.ledger.axioms.length === 0,
)
ok('no line was stray', refused.stray === 0)
const odd = plan.readHold(
  'not json\n{"kind":"close","glyph":"done"}\n',
  0,
)
ok(
  'a stray line is counted, never fatal, and exit 0 holds',
  odd.holds &&
    odd.stray === 1 &&
    odd.problems.length === 0 &&
    odd.summary === undefined,
)

const feedback = plan.feedbackOf(refused, {
  lineAt: where =>
    where === 'code/law.tree:543:1' ? 'task isolation' : undefined,
})
ok(
  'the model is told the verdict, the problem, its source line and the next step',
  /DOES NOT HOLD\. 1 problem\./.test(feedback) &&
    /at code\/law\.tree:543:1: task isolation/.test(feedback) &&
    /next: the type/.test(feedback),
  feedback,
)
const many: plan.HoldRead = {
  holds: false,
  problems: Array.from({ length: 20 }, (_, i) => ({
    subject: `p${i}`,
    detail: [],
  })),
  stray: 0,
}
ok(
  'at most twelve problems are fed back, and the rest counted',
  /8 more problems not shown/.test(
    plan.feedbackOf(many, { lineAt: () => undefined }),
  ) &&
    !/- p12/.test(plan.feedbackOf(many, { lineAt: () => undefined })),
)

// ---- the gate ----

const holding = (
  over: Partial<plan.HoldSummary> = {},
): plan.HoldRead => ({
  holds: true,
  problems: [],
  stray: 0,
  summary: {
    files: 2,
    failed: [],
    open: [],
    total: 2,
    proven: 2,
    fresh: [],
    ledger: { native: [], axioms: [], unending: [], roaming: [] },
    kernel: { proven: 10, commands: 0, declined: 0, reasons: [] },
    ...over,
  },
})
const law = (
  name: string,
  kind: 'claim' | 'theorem' | 'axiom' = 'claim',
) => ({ name, kind, text: `${name} in words.`, words: [] })
const required = ['ownership', 'isolation']

ok(
  'a project that holds with both laws as claims passes',
  plan.gateOf({
    hold: holding(),
    laws: [law('ownership'), law('isolation')],
    required,
    lean: false,
  }).ok,
)
ok(
  'a missing law fails it by name',
  plan
    .gateOf({
      hold: holding(),
      laws: [law('ownership')],
      required,
      lean: false,
    })
    .reasons.includes('there is no law named isolation'),
)
ok(
  'a theorem in place of a claim fails it',
  !plan.gateOf({
    hold: holding(),
    laws: [law('ownership'), law('isolation', 'theorem')],
    required,
    lean: false,
  }).ok,
)
ok(
  'an axiom anywhere fails it',
  !plan.gateOf({
    hold: holding({
      ledger: {
        native: [],
        axioms: ['code/law.tree trust-me'],
        unending: [],
        roaming: [],
      },
    }),
    laws: [law('ownership'), law('isolation')],
    required,
    lean: false,
  }).ok,
)
ok(
  'a hold that does not hold fails it',
  !plan.gateOf({
    hold: { ...holding(), holds: false },
    laws: [law('ownership'), law('isolation')],
    required,
    lean: false,
  }).ok,
)
const leanOf = (claims: plan.HoldLeanClaim[], missing = false) =>
  holding({
    lean: {
      missing,
      claims,
      ok: !missing && claims.every(c => c.verdict === 'checked'),
    },
  })
const checked = (name: string): plan.HoldLeanClaim => ({
  name,
  file: 'code/law.tree',
  verdict: 'checked',
  axioms: [],
})
ok(
  'under --lean, both laws checked by Lean pass',
  plan.gateOf({
    hold: leanOf([checked('ownership'), checked('isolation')]),
    laws: [law('ownership'), law('isolation')],
    required,
    lean: true,
  }).lean === 'checked',
)
const leanRefused = plan.gateOf({
  hold: leanOf([
    checked('ownership'),
    { ...checked('isolation'), verdict: 'refused' },
  ]),
  laws: [law('ownership'), law('isolation')],
  required,
  lean: true,
})
ok(
  'a law Lean refuses fails it, named',
  !leanRefused.ok &&
    leanRefused.lean === 'failed' &&
    /isolation/.test(leanRefused.reasons.join()),
  leanRefused.reasons.join('; '),
)
ok(
  'no Lean on the machine fails it',
  !plan.gateOf({
    hold: leanOf([], true),
    laws: [law('ownership'), law('isolation')],
    required,
    lean: true,
  }).ok,
)
const othersDeclined = plan.gateOf({
  hold: {
    ...leanOf([
      checked('ownership'),
      checked('isolation'),
      { ...checked('safe-text'), verdict: 'declined' },
    ]),
    holds: false,
  },
  laws: [law('ownership'), law('isolation')],
  required,
  lean: true,
})
ok(
  'any claim Lean declines fails the gate through the exit, and the report names it',
  !othersDeclined.ok &&
    othersDeclined.reasons[0] ===
      'term hold --lean --report does not exit 0' &&
    /safe-text \(declined\)/.test(othersDeclined.notes[0] ?? ''),
  JSON.stringify(othersDeclined),
)
const rowFails = plan.gateOf({
  hold: holding({
    report: {
      page: '',
      holds: false,
      top: '',
      laws: [
        {
          name: 'isolation',
          holds: false,
          why: 'a diagnostic inside view',
        },
      ],
    },
  }),
  laws: [law('ownership'), law('isolation')],
  required,
  lean: false,
})
ok(
  "a law the report's row says does not hold fails it",
  !rowFails.ok &&
    /isolation does not hold: a diagnostic inside view/.test(
      rowFails.reasons.join(),
    ),
  rowFails.reasons.join('; '),
)
const older = plan.gateOf({
  hold: holding(),
  laws: [law('ownership'), law('isolation')],
  required,
  lean: true,
})
ok(
  'a term hold with no --lean yet passes on its own verdict and says Lean was unavailable',
  older.ok && older.lean === 'unavailable',
)

// ---- what a model may write ----

ok('code/law.tree may be written', codePath('/p', 'code/law.tree').ok)
ok(
  'a nested .tree under code/ may be written',
  codePath('/p', 'code/a/b.tree').ok,
)
ok('deck.tree may not', !codePath('/p', 'deck.tree').ok)
ok(
  'a path climbing out may not',
  !codePath('/p', 'code/../../etc/x.tree').ok,
)
ok('an absolute path may not', !codePath('/p', '/p/code/x.tree').ok)
ok('a file that is not .tree may not', !codePath('/p', 'code/x.ts').ok)
ok('an empty path may not', !codePath('/p', '').ok)

// ---- the law library and the instance check (call/code/knit-law.ts), no term hold ----

const root = packageRoot()
mkdirSync(join(root, 'tmp/knit-test'), { recursive: true })
const lawDir = removeAtExit(
  mkdtempSync(join(root, 'tmp/knit-test', 'law-')),
)
const library = libraryNames(root)
ok(
  'the library holds the three state laws of the MVP',
  ['deleted-stays-gone', 'isolation', 'ownership'].every(name =>
    library.includes(name),
  ),
  library.join(','),
)
const isoLaw = libraryLaw(root, 'isolation')!
ok(
  "a library law is a template named for it, whose holes are the app's forms and its task",
  isoLaw.template === 'isolation-law' &&
    isoLaw.params.join() === 'state,natural,rank,person,view',
  JSON.stringify(isoLaw.params),
)
ok(
  'ownership is generic over the step task, the two view laws over the view task',
  libraryLaw(root, 'ownership')!.params.includes('step') &&
    libraryLaw(root, 'deleted-stays-gone')!.params.includes('view'),
)
ok(
  'a name the library lacks is no law',
  libraryLaw(root, 'no-such-law') === undefined,
)
const allLaws = library.flatMap(name => libraryLaw(root, name) ?? [])
const fixture = join(root, 'test/assurance/library')

// a copy of a project to check, its code/ files replaced or added as given
function projectOf(
  name: string,
  from: string,
  files: Record<string, string> = {},
): string {
  const dir = join(lawDir, name)
  cpSync(from, dir, {
    recursive: true,
    filter: source =>
      !source.includes('/.base') && !source.includes('/host'),
  })
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(dir, file), text)
  }
  return dir
}

const instancesOf = (
  project: string,
  laws = ['ownership', 'isolation', 'deleted-stays-gone'],
) =>
  checkInstances({
    project,
    required: laws,
    laws: allLaws,
    roleOf: projectRoleOf(project),
    leanOf: projectLeanOf(project),
  })

const good = projectOf('good', fixture)
const goodText = readFileSync(join(good, 'code/law.tree'), 'utf8')
ok(
  'the fixture is sealed: sealing it again changes nothing',
  sealed(goodText, allLaws) === goodText &&
    seal(good, allLaws).length === 0,
)
ok(
  'what the model writes is the text above the marker',
  !ownText(goodText).includes(LIBRARY_MARK) &&
    ownText(goodText).includes('fuse isolation-law') &&
    !ownText(goodText).includes('tree isolation-law'),
)
const correct = instancesOf(good)
ok(
  "A CORRECT INSTANCE PASSES: each of the three laws is the library statement filled with the app's names",
  correct.every(one => one.ok) &&
    correct.find(one => one.law === 'isolation')?.fill?.view ===
      'view' &&
    correct.find(one => one.law === 'ownership')?.fill?.step === 'step',
  JSON.stringify(correct),
)
ok(
  'its law reads in English from the library statement',
  /owned holds of \(person with id i and rank r\) and \(the view of s/.test(
    correct.find(one => one.law === 'isolation')?.english ?? '',
  ),
  correct.find(one => one.law === 'isolation')?.english,
)

const tampered = projectOf('tampered', fixture)
writeFileSync(
  join(tampered, 'code/law.tree'),
  goodText.replace(
    '      call {view}',
    '      call {view}\n        read s',
  ),
)
ok(
  'an edit below the marker is undone by the seal',
  seal(tampered, allLaws).join() === 'code/law.tree' &&
    readFileSync(join(tampered, 'code/law.tree'), 'utf8') === goodText,
)

// run-4-no-example of the real loop: it holds, and its isolation is a second statement of the delete policy
const restated = projectOf(
  'restated',
  join(root, 'test/call/knit-fixture/restated'),
)
const [ownR, isoR] = instancesOf(restated, ['ownership', 'isolation'])
ok(
  "A PROJECT WHOSE ISOLATION RESTATES DELETE IS REFUSED: a claim written by hand under the law's name is no instance, and the model is told how to state it",
  !isoR!.ok &&
    /`rule isolation` is written by hand/.test(isoR!.problem ?? '') &&
    /fuse isolation-law\n {2}bind state, <your state>/.test(
      isoR!.problem ?? '',
    ) &&
    !ownR!.ok,
  JSON.stringify(isoR),
)

// the same restatement put in a template of the library's name, fused
const restatedText = readFileSync(
  join(restated, 'code/law.tree'),
  'utf8',
)
const ruleStart = restatedText.indexOf('rule isolation\n')
const ruleEnd = restatedText.indexOf('task isolation\n')
const ownTemplate = projectOf(
  'own-template',
  join(root, 'test/call/knit-fixture/restated'),
  {
    'code/law.tree': [
      restatedText.slice(0, ruleStart) + restatedText.slice(ruleEnd),
      'tree isolation-law',
      '  hook fuse',
      ...restatedText
        .slice(ruleStart, ruleEnd)
        .trimEnd()
        .split('\n')
        .map(one => `    ${one}`),
      '',
      'fuse isolation-law',
      '',
    ].join('\n'),
  },
)
const ownTemplateIso = instancesOf(ownTemplate, ['isolation'])[0]!
ok(
  "a template of the library's name written by hand is refused",
  !ownTemplateIso.ok &&
    /`tree isolation-law` is written by hand/.test(
      ownTemplateIso.problem ?? '',
    ),
  JSON.stringify(ownTemplateIso),
)

// the library's isolation fused, but of a view written beside the law that shows nothing, so the law holds of nothing
const foreign = projectOf('foreign', fixture, {
  'code/law.tree':
    ownText(goodText).replace(
      'fuse isolation-law\n  bind state, shelf\n  bind natural, natural\n  bind rank, rank\n  bind person, person\n  bind view, view',
      'fuse isolation-law\n  bind state, shelf\n  bind natural, natural\n  bind rank, rank\n  bind person, person\n  bind view, show-nothing',
    ) +
    '\ntask show-nothing\n  take s, like shelf\n  take p, like person\n  like shelf\n  back make bare\n',
})
const foreignIso = instancesOf(foreign, ['isolation'])[0]!
ok(
  "a hole bound to something that is not the app's own (a task beside the law) is refused",
  !foreignIso.ok &&
    /`bind view, show-nothing`/.test(foreignIso.problem ?? '') &&
    /is not/.test(foreignIso.problem ?? ''),
  JSON.stringify(foreignIso),
)

const partial = projectOf('partial', fixture, {
  'code/law.tree': ownText(goodText).replace(
    'fuse isolation-law\n  bind state, shelf\n',
    'fuse isolation-law\n',
  ),
})
const partialIso = instancesOf(partial, ['isolation'])[0]!
ok(
  'a fuse that leaves a hole out is refused, naming it',
  !partialIso.ok && /leaves out state/.test(partialIso.problem ?? ''),
  JSON.stringify(partialIso),
)
const twice = projectOf('twice', fixture, {
  'code/law.tree':
    ownText(goodText) +
    '\nfuse isolation-law\n  bind state, shelf\n  bind natural, natural\n  bind rank, rank\n  bind person, person\n  bind view, view\n',
})
ok(
  'a law fused twice is refused',
  /fused 2 times/.test(
    instancesOf(twice, ['isolation'])[0]!.problem ?? '',
  ),
)
const unstated = projectOf(
  'unstated',
  join(root, 'test/call/knit-fixture/restated'),
  { 'code/law.tree': '# nothing yet\n' },
)
ok(
  'a law not stated at all is refused with the fuse to write',
  /isolation is not stated/.test(
    instancesOf(unstated, ['isolation'])[0]!.problem ?? '',
  ),
)
ok(
  'a law the library lacks is refused by name',
  /no law named made-up in the law library/.test(
    checkInstances({
      project: good,
      required: ['made-up'],
      laws: allLaws,
      roleOf: () => undefined,
      leanOf: () => true,
    })[0]!.problem ?? '',
  ),
)

const instanceGate = plan.gateOf({
  hold: holding(),
  laws: [law('ownership'), law('isolation')],
  required,
  lean: false,
  instances: [{ law: 'ownership', ok: true }, isoR!],
})
ok(
  "the gate fails on a law that is not the library's, naming it, even when term hold holds",
  !instanceGate.ok &&
    /^isolation is not the law library's isolation: `rule isolation` is written by hand/.test(
      instanceGate.reasons[0] ?? '',
    ),
  instanceGate.reasons.join('; '),
)
ok(
  'and passes when every named law is an instance',
  plan.gateOf({
    hold: holding(),
    laws: [law('ownership'), law('isolation')],
    required,
    lean: false,
    instances: correct,
  }).ok,
)
ok(
  "the first message carries each named law's library text and the fuse to write",
  (() => {
    const first = firstMessage({
      spec: 's',
      required: ['isolation'],
      library: [isoLaw],
    })
    return (
      first.includes('tree isolation-law') &&
      first.includes(
        'fuse isolation-law\n  bind state, <your state>',
      ) &&
      first.includes('task isolation')
    )
  })(),
)

// ---- the system prompt and tools ----

const system = systemOf(root, true)
ok(
  'the system prompt carries the syntax, the proof guide, the traps and the example',
  [
    'deck/term/CLAUDE',
    'law-and-proof.md',
    'traps.md',
    'EXAMPLE code/law.tree',
  ].every(part => system.includes(part.split('/').pop()!)),
)
ok(
  'the system prompt is the same bytes every time, so it caches',
  systemOf(root, true) === system,
)
ok(
  'without the example it is shorter and has no example',
  !systemOf(root, false).includes('EXAMPLE') &&
    systemOf(root, false).length < system.length,
)
ok(
  'every tool takes an object with no other properties',
  TOOLS.every(tool => tool.input_schema.additionalProperties === false),
)

// ---- the request, and the raw-HTTP client it goes through (deck/make/code/code/api-client.ts) ----

const { body, betas } = bodyOf({
  model: 'claude-opus-5-5',
  effort: 'high',
  maxTokens: 64000,
  system: 'S',
  tools: TOOLS,
  messages: [{ role: 'user', content: 'hi' }],
})
ok(
  'the request thinks adaptively at the effort asked, with no budget and no temperature',
  JSON.stringify(body.thinking) === '{"type":"adaptive"}' &&
    JSON.stringify(body.output_config) === '{"effort":"high"}' &&
    !('temperature' in body),
)
ok(
  'the system prompt and the conversation are cached for an hour',
  JSON.stringify(body.system).includes('"ttl":"1h"') &&
    JSON.stringify(body.cache_control) ===
      '{"type":"ephemeral","ttl":"1h"}',
)
ok(
  'every tool is strict',
  (body.tools as { strict?: boolean }[]).every(
    tool => tool.strict === true,
  ),
)
ok(
  'Opus 5.5 asks for the server-side refusal fallback, with its beta',
  body.fallbacks === 'default' &&
    betas.join() === 'server-side-fallback-2026-07-01',
)
ok(
  'a model without the fallback sends neither',
  !(
    'fallbacks' in
    bodyOf({
      model: 'claude-sonnet-5-5',
      effort: 'low',
      maxTokens: 1,
      system: '',
      tools: [],
      messages: [],
    }).body
  ),
)

// a stream shaped as the Messages API sends it: a thinking block with its signature, text, a tool call whose input
// comes in pieces, and the final usage on message_delta
const EVENTS: Record<string, unknown>[] = [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 300,
        output_tokens: 1,
      },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'let me ' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'think' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'SIG' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Writing ü' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start',
    index: 2,
    content_block: {
      type: 'tool_use',
      id: 'tu_1',
      name: 'write_file',
      input: {},
    },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"path":"code/a.tree",',
    },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: {
      type: 'input_json_delta',
      partial_json: '"content":"task x\\n"}',
    },
  },
  { type: 'content_block_stop', index: 2 },
  { type: 'ping' },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 420 },
  },
  { type: 'message_stop' },
]
const sse = EVENTS.map(
  event =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
).join('')

const applied: StreamedMessage = { content: [], usage: {} }
const pieces = new Map<number, string>()
EVENTS.forEach(event => applyStreamEvent(applied, event, pieces))
ok(
  'the stream builds the whole message: thinking with its signature, text, the tool input parsed, the final usage',
  JSON.stringify(applied.content) ===
    JSON.stringify([
      { type: 'thinking', thinking: 'let me think', signature: 'SIG' },
      { type: 'text', text: 'Writing ü' },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'write_file',
        input: { path: 'code/a.tree', content: 'task x\n' },
      },
    ]) &&
    applied.stop_reason === 'tool_use' &&
    applied.usage.output_tokens === 420 &&
    applied.usage.cache_read_input_tokens === 2000,
  JSON.stringify(applied),
)

// a local server in place of the API: the stream cut into 7-byte chunks (mid-line, mid-character), an overload then
// success, a refusal that is not retried, and a stream that breaks after it started
const asked: {
  headers: Record<string, unknown>
  body: Record<string, unknown>
}[] = []
let mode = 'ok'
let overloads = 0
const server = createServer((request, response) => {
  let text = ''
  request.on('data', chunk => (text += chunk))
  request.on('end', async () => {
    asked.push({
      headers: request.headers,
      body: JSON.parse(text) as Record<string, unknown>,
    })

    if (mode === 'overload' && overloads++ === 0) {
      response.writeHead(529, {
        'content-type': 'application/json',
        'retry-after': '0',
      })
      response.end(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      )
      return
    }

    if (mode === 'bad') {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        '{"type":"error","error":{"type":"invalid_request_error","message":"no"}}',
      )
      return
    }

    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const bytes = Buffer.from(
      mode === 'broken'
        ? sse.slice(0, sse.indexOf('content_block_start'))
        : sse,
    )

    for (let at = 0; at < bytes.length; at += 7) {
      response.write(bytes.subarray(at, at + 7))
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    response.end()
  })
})
await new Promise<void>(resolve =>
  server.listen(0, '127.0.0.1', () => resolve()),
)
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
const noWait = async (): Promise<void> => {}

const streamed = await streamMessage({
  apiKey: 'k',
  body: { model: 'm', messages: [] },
  betas: ['b-1', 'b-2'],
  baseUrl,
  wait: noWait,
})
ok(
  'a stream cut into 7-byte pieces reads to the same message',
  JSON.stringify(streamed.content) ===
    JSON.stringify(applied.content) &&
    streamed.usage.output_tokens === 420,
  JSON.stringify(streamed).slice(0, 400),
)
ok(
  'the request carries the key, the version, the betas joined, and stream: true',
  asked[0]!.headers['x-api-key'] === 'k' &&
    asked[0]!.headers['anthropic-version'] === '2023-06-01' &&
    asked[0]!.headers['anthropic-beta'] === 'b-1,b-2' &&
    asked[0]!.body.stream === true,
)
mode = 'overload'
asked.length = 0
const retried = await streamMessage({
  apiKey: 'k',
  body: {},
  baseUrl,
  wait: noWait,
})
ok(
  'an overload is retried, and the retry reads the message',
  asked.length === 2 && retried.stop_reason === 'tool_use',
)
mode = 'bad'
asked.length = 0
const refusedRequest = await streamMessage({
  apiKey: 'k',
  body: {},
  baseUrl,
  wait: noWait,
}).then(
  () => undefined,
  (error: unknown) => error as MessageRequestError,
)
ok(
  'a 400 is thrown at once with the API message, never retried',
  asked.length === 1 &&
    refusedRequest?.status === 400 &&
    /invalid_request_error/.test(refusedRequest.message),
)
mode = 'broken'
asked.length = 0
const brokenRequest = await streamMessage({
  apiKey: 'k',
  body: {},
  baseUrl,
  wait: noWait,
  retryBroken: false,
}).then(
  () => undefined,
  (error: unknown) =>
    error as {
      usage?: Record<string, unknown>
      brokenUsage?: unknown[]
    },
)
ok(
  'a stream that broke after it started is thrown with what it was billed, not retried, under retryBroken: false',
  asked.length === 1 &&
    brokenRequest?.usage?.input_tokens === 10 &&
    brokenRequest.brokenUsage?.length === 1,
  JSON.stringify(brokenRequest),
)
server.close()

// ---- the loop, end to end, with a scripted model and the real term hold ----

const line = lineOf(root)
// round 1: run-4-no-example's project, which holds, its isolation the delete policy restated by hand. Round 2: the
// library fixture, the three laws fused from the library and proven of the notes demo's model, the model's text only
const restatedFiles = ['model.tree', 'law.tree'].map(name => ({
  name,
  text: readFileSync(
    join(root, 'test/call/knit-fixture/restated/code', name),
    'utf8',
  ),
}))
const fixtureFiles = ['model.tree', 'law.tree'].map(name => ({
  name,
  text: ownText(readFileSync(join(fixture, 'code', name), 'utf8')),
}))
const workDir = join(root, 'tmp/knit-test')
mkdirSync(workDir, { recursive: true })

let toolId = 0
const use = (
  name: string,
  input: Record<string, unknown> = {},
): Block => ({ type: 'tool_use', id: `t${++toolId}`, name, input })
const turnOf = (
  content: Block[],
  usage: plan.Usage = { input_tokens: 1000, output_tokens: 500 },
  stopReason = 'tool_use',
): Turn => ({
  content,
  usage,
  stopReason,
  model: 'claude-opus-5-5',
  fellBack: false,
})

function scripted(turns: Turn[], seen: unknown[][] = []): Speaker {
  let i = 0

  return {
    model: 'claude-opus-5-5',
    async ask({ messages }) {
      seen.push(JSON.parse(JSON.stringify(messages)) as unknown[])
      return turns[Math.min(i++, turns.length - 1)]!
    },
  }
}

const leanBinary =
  process.env.TERM_LEAN ??
  spawnSync('which', ['lean'], { encoding: 'utf8' }).stdout.trim()
const hasLean = leanBinary !== '' && existsSync(leanBinary)
const base = {
  root,
  spec: 'only the owner of a note, or an admin, can delete it',
  required,
  lean: false,
  example: true,
  model: 'claude-opus-5-5',
  maxTokens: 1000,
  line,
}

if (existsSync(line)) {
  const seen: unknown[][] = []
  const out = removeAtExit(mkdtempSync(join(workDir, 'loop-')))
  // with --lean where Lean 4 is installed (TERM_LEAN, else the PATH): Lean re-checks the two laws
  const run = await knitLoop(
    {
      ...base,
      lean: hasLean,
      name: 'scripted',
      out,
      limits: { rounds: 5, turns: 6, minutes: 10, cap: 25 },
    },
    scripted(
      [
        turnOf([
          { type: 'text', text: 'A first try.' },
          ...restatedFiles.map(({ name, text }) =>
            use('write_file', { path: `code/${name}`, content: text }),
          ),
          use('write_file', { path: 'deck.tree', content: 'x' }),
          use('hold'),
        ]),
        turnOf([
          ...fixtureFiles.map(({ name, text }) =>
            use('write_file', { path: `code/${name}`, content: text }),
          ),
          use('laws'),
          use('hold'),
        ]),
        turnOf(
          [{ type: 'text', text: 'never asked' }],
          undefined,
          'end_turn',
        ),
      ],
      seen,
    ),
  )
  const r = run.result
  ok(
    'the scripted run holds in two rounds and two requests',
    r.verdict === 'holds' && r.rounds === 2 && r.turns === 2,
    JSON.stringify({
      verdict: r.verdict,
      stop: r.stop,
      rounds: r.rounds,
      turns: r.turns,
      gate: r.gate,
    }),
  )
  ok(
    'the spend is the usage priced',
    near(r.spend.dollars, (2 * (1000 * 4 + 500 * 20)) / 1e6),
  )
  const firstResults = JSON.stringify(seen[1]?.[2] ?? '')
  ok(
    'round 1: the restated project HOLDS under term hold, and the instance check refuses it, telling the model how to state the law',
    /term hold: HOLDS\./.test(firstResults) &&
      /isolation is not the law library's isolation: `rule isolation` is written by hand/.test(
        firstResults,
      ) &&
      /fuse isolation-law/.test(firstResults),
    firstResults.slice(0, 900),
  )
  ok(
    'round 1 is in the transcript as holding under term hold and failing the gate on the instance',
    run.transcript.rounds[0]!.holds &&
      (run.transcript.rounds[0]!.gate ?? []).some(reason =>
        /not the law library's isolation/.test(reason),
      ),
    JSON.stringify(run.transcript.rounds[0]),
  )
  ok(
    'a write outside code/ was refused to the model and not made',
    /only files under code\/ may be written/.test(firstResults) &&
      readFileSync(join(out, 'project/deck.tree'), 'utf8').startsWith(
        'deck @knit/',
      ),
  )
  ok(
    'every tool use had its result in the next message',
    JSON.stringify(seen[1]).split('"tool_result"').length - 1 === 4,
  )
  ok(
    'the run ends with each named law an instance of the library',
    (r.instances ?? []).length === 2 &&
      (r.instances ?? []).every(one => one.ok),
    JSON.stringify(r.instances),
  )
  ok(
    "the project's law file is sealed: the library's text below the marker",
    (() => {
      const sealedLaw = readFileSync(
        join(out, 'project/code/law.tree'),
        'utf8',
      )
      return (
        sealedLaw.includes(`${LIBRARY_MARK}\n\n# LAW`) &&
        [
          'tree ownership-law',
          'tree isolation-law',
          'tree deleted-stays-gone-law',
        ].every(
          one =>
            sealedLaw.indexOf(one) > sealedLaw.indexOf(LIBRARY_MARK),
        )
      )
    })(),
  )
  const own = r.laws.find(one => one.name === 'ownership')
  const iso = r.laws.find(one => one.name === 'isolation')
  ok(
    "the laws are the renderer's English from the Term form",
    !!own?.text &&
      !!iso?.text &&
      own.kind === 'claim' &&
      iso.kind === 'claim',
    JSON.stringify([own, iso]),
  )
  const page = plan.reportOf(r)
  ok(
    'the report names both laws in words and the spend',
    page.includes(`ownership  holds\n    ${own?.text}`) &&
      page.includes(`isolation  holds\n    ${iso?.text}`) &&
      /spent: \$0\.0280 of a \$25\.00 cap/.test(page),
    page.slice(0, 1200),
  )
  ok(
    "the report says each law is the library's, and with what fill",
    page.includes(
      "the law library's isolation (@term/site/law/isolation.tree), filled with state shelf, natural natural, rank rank, person person, view view",
    ),
    page.slice(0, 1500),
  )
  ok(
    "term hold --report reports the two laws the loop named in laws.tree, and the run's report carries its page",
    !!r.summary?.report?.page &&
      /ownership/.test(r.summary.report.page) &&
      /isolation/.test(r.summary.report.page) &&
      page.includes('term hold --report:') &&
      readFileSync(join(out, 'project/laws.tree'), 'utf8').includes(
        'host rule, <isolation>',
      ),
    (r.summary?.report?.page ?? 'no report').slice(0, 800),
  )

  if (hasLean) {
    ok(
      'Lean 4 re-checked both laws, and the report counts the claims it checked',
      r.gate.lean === 'checked' &&
        /re-checked in Lean 4: \d+ of \d+/.test(page),
      JSON.stringify(r.gate),
    )
  } else {
    console.log(
      'skip  the Lean re-check in the loop: no Lean at TERM_LEAN or on the PATH',
    )
  }
  ok(
    'the TypeScript was emitted',
    r.emitted.some(file => file.endsWith('.ts')),
    r.emitted.join(','),
  )
  ok(
    'the transcript has a line per turn and per round',
    run.transcript.turns.length === 2 &&
      run.transcript.rounds.length === 2 &&
      run.transcript.rounds[1]!.holds,
  )

  // the cap, with answers too dear to afford a second
  const dear = await knitLoop(
    {
      ...base,
      name: 'dear',
      out: removeAtExit(mkdtempSync(join(workDir, 'dear-'))),
      limits: { rounds: 50, turns: 50, minutes: 10, cap: 1 },
    },
    scripted([
      turnOf([use('laws')], {
        input_tokens: 100_000,
        output_tokens: 20_000,
      }),
    ]),
  )
  ok(
    'the cap stops a run before a request that could pass it, and the run spent no more than the cap',
    dear.result.stop.startsWith('Stopped at the spend cap') &&
      dear.result.spend.dollars <= 1,
    `${dear.result.stop} ${dear.result.spend.dollars}`,
  )

  // a stream that broke partway: its billed usage counts at the ceiling, and the request is asked again
  let brokeOnce = false
  const flaky = await knitLoop(
    {
      ...base,
      name: 'flaky',
      out: removeAtExit(mkdtempSync(join(workDir, 'flaky-'))),
      limits: { rounds: 5, turns: 2, minutes: 10, cap: 25 },
    },
    {
      model: 'claude-opus-5-5',
      async ask() {
        if (!brokeOnce) {
          brokeOnce = true
          throw new KnitRequest(
            'the stream ended before the message did',
            [{ input_tokens: 1_000_000 }],
          )
        }

        return turnOf(
          [{ type: 'text', text: 'ok' }],
          undefined,
          'end_turn',
        )
      },
    },
  )
  ok(
    'a broken stream is counted at the dearest input rate and asked again',
    flaky.result.turns === 2 &&
      near(
        flaky.result.spend.dollars,
        plan.CEILING.input + (1000 * 4 + 500 * 20) / 1e6,
      ) &&
      flaky.transcript.turns[0]!.stop === 'error',
    JSON.stringify(flaky.result.spend),
  )

  // a model that never calls a tool is nudged, and the turn limit ends it
  const idle = await knitLoop(
    {
      ...base,
      name: 'idle',
      out: removeAtExit(mkdtempSync(join(workDir, 'idle-'))),
      limits: { rounds: 5, turns: 3, minutes: 10, cap: 25 },
    },
    scripted([
      turnOf(
        [{ type: 'text', text: 'thinking aloud' }],
        undefined,
        'end_turn',
      ),
    ]),
  )
  ok(
    'a model that writes nothing is nudged and stopped at the turn limit',
    idle.result.turns === 3 &&
      /3 requests/.test(idle.result.stop) &&
      idle.messages.filter(m => m.role === 'user').length === 4,
  )

  // an answer cut off at max_tokens: its calls are answered as not run
  const cutOut = removeAtExit(mkdtempSync(join(workDir, 'cut-')))
  const cut = await knitLoop(
    {
      ...base,
      name: 'cut',
      out: cutOut,
      limits: { rounds: 5, turns: 1, minutes: 10, cap: 25 },
    },
    scripted([
      turnOf(
        [
          use('write_file', {
            path: 'code/law.tree',
            content: 'task x',
          }),
        ],
        undefined,
        'max_tokens',
      ),
    ]),
  )
  ok(
    'a call in an answer cut off at max_tokens is not run, and is answered so',
    !existsSync(join(cutOut, 'project/code/law.tree')) &&
      JSON.stringify(cut.messages.at(-1)).includes(
        'cut off at the output limit',
      ),
  )

  // ---- the command ----

  const bare = spawnSync(process.execPath, [line, 'knit'], {
    cwd: workDir,
    encoding: 'utf8',
  })
  ok(
    'term knit with no spec is a usage error, exit 2',
    bare.status === 2 && /There is no spec/.test(bare.stderr),
    `${bare.status} ${bare.stderr.slice(0, 300)}`,
  )
  const madeUp = spawnSync(
    process.execPath,
    [
      line,
      'knit',
      'only the owner can delete a note',
      '--law',
      'made-up',
      '--name',
      'made-up',
      '--out',
      join(workDir, `made-up-${process.pid}`),
    ],
    { cwd: workDir, encoding: 'utf8' },
  )
  ok(
    'a --law the library lacks is a usage error before any request, naming the laws it has',
    madeUp.status === 2 &&
      /no law named made-up/.test(madeUp.stderr) &&
      /isolation/.test(madeUp.stderr),
    `${madeUp.status} ${madeUp.stderr.slice(0, 400)}`,
  )
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env
  const keyless = spawnSync(
    process.execPath,
    [
      line,
      'knit',
      'only the owner can delete a note',
      '--name',
      'keyless',
      '--out',
      join(workDir, `keyless-${process.pid}`),
    ],
    { cwd: workDir, encoding: 'utf8', env },
  )
  // the next step names a zone generically (knit-model.ts, 2026-10-22: a shipped CLI names no path of this repository),
  // and the renderer wraps it, so the words are matched with the line breaks read as spaces
  const keylessText = keyless.stderr.replace(/\s+/g, ' ')
  ok(
    'term knit without a key stops before any request, naming the zone',
    keyless.status !== 0 &&
      /ANTHROPIC_API_KEY is not set/.test(keylessText) &&
      /zone load <zone> -- term knit/.test(keylessText),
    `${keyless.status} ${keyless.stderr.slice(0, 400)}`,
  )
  const help = spawnSync(process.execPath, [line, '--hint'], {
    cwd: workDir,
    encoding: 'utf8',
    env,
  })
  ok(
    'term starts with no key and lists knit',
    help.status === 0 && /term knit/.test(help.stdout),
    help.stdout.slice(0, 200),
  )
} else {
  console.log(
    `skip  the loop and the command: ${line} is not built (pnpm run make:line)`,
  )
}

console.log(`\nknit: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
