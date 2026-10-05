// The 31 mockup cards of note/term/output/mockups.html, each as the EVENTS a command would hand the library, and the
// patches that turn the mockup into the spec-correct rendering. Every patch names its entry in
// note/term/output/mockup-differences.md (D01 ...): a mockup line is never changed without one, and golden.ts holds
// the note and these patches to the same set of entries.

import { blankEvent, plainSubject } from '@term/call/code/work/item/event'
import type { Event, Span } from '@term/call/code/work/item/event'
import type { Line, Room } from '@term/call/code/work/item/layout'
import { blankLine } from '@term/call/code/work/item/layout'
import { drawItem } from '@term/call/code/work/item/item'
import {
  closeSession,
  drawOpening,
  failSession,
  makeCrash,
  makeOpening,
  makeOptions,
  openSession,
  stepSession,
} from '@term/call/code/work/item/run'
import type { RunOptions } from '@term/call/code/work/item/run'
import { formatChain, formatChange, formatZone } from '@term/call/code/work/item/format'
import { makeProgressItem, placeItem, planFrame } from '@term/call/code/work/item/live'
import type { Region } from '@term/call/code/work/item/live'
import { drawFooter, makeDateItem, makeServiceOpening, makeUpItem } from '@term/call/code/work/item/service'
import { failWithoutTerminal, questionEvent } from '@term/call/code/work/item/ask'
import type { Question } from '@term/call/code/work/item/ask'
import { adaptLine } from '@term/call/code/work/item/adapt'
import {
  B,
  BLANK,
  I,
  OFFSET,
  STANDARD,
  T,
  at,
  d,
  ev,
  field,
  frame,
  node,
  o,
  plain,
  replace,
  retint,
  row,
  s,
  tally,
  w,
  x,
} from './build'
import type { Card, Expected } from './build'

// a run through the session, the way a command drives one: opening, events, then a failure and the closing
function run(
  room: Room,
  opening: Event,
  events: Event[],
  closing: Event | null,
  options: Partial<RunOptions> = {},
  failure = '',
  tagged = true,
): Line[] {
  let session = openSession(opening.verb, { ...makeOptions(), ...options })
  const out: Line[] = []
  let step = drawOpening(session, opening, room)
  session = step.session
  out.push(...step.lines)

  for (const event of events) {
    step = stepSession(session, event, room, tagged)
    session = step.session
    out.push(...step.lines)
  }

  if (failure) {
    session = failSession(session, failure)
  }

  if (closing) {
    out.push(...closeSession(session, closing, room).lines)
  }

  return out
}

function items(room: Room, events: Event[], tagged = true): Line[] {
  return events.flatMap(event => drawItem(event, room, tagged))
}

function opening(verb: string, subject: string, clock: string, tool: string[], extra: Partial<Event> = {}): Event {
  const one = makeOpening(verb, subject, T(clock), '')
  return { ...one, tool, ...extra }
}

function zone(room: Room): string {
  return formatZone('PDT', OFFSET, false, room)
}

function chain(links: string[], room: Room): Span[] {
  return formatChain(links, room)
}

// ---- shared events ----

function testRun(room: Room): Line[] {
  return run(
    room,
    opening('test', 'code/', '14:42:00.005', ['term 2.5.22'], { tallies: [tally(3, 'files')] }),
    [
      ev({ glyph: 'done', verb: 'test', subject: 'area.test.tree', clock: '14:42:00.017', duration: 12, tallies: [tally(8, 'tests'), tally(8, 'passed')] }),
      ev({ glyph: 'done', verb: 'test', subject: 'list.test.tree', clock: '14:42:00.047', duration: 30, tallies: [tally(9, 'tests'), tally(9, 'passed')] }),
      ev({
        glyph: 'failed',
        kind: 'problem',
        verb: 'case',
        subject: 'Average of an empty list',
        clock: '14:42:00.088',
        duration: 41,
        fields: [at('code/stats.test.tree:18:3'), field('want', '0'), field('gave', '1'), field('next', 'Return 0 when the list is empty.')],
        frames: [frame([[18, 'want average(make list) equals 0']], [{ line: 18, column: 6, length: 18, label: 'gave 1, not 0' }])],
      }),
      ev({ glyph: 'skipped', kind: 'problem', verb: 'case', subject: 'Median of a huge list', clock: '14:42:00.093', fields: [field('reason', 'Marked slow.')] }),
    ],
    ev({ subject: 'Test run failed', clock: '14:42:00.176', duration: 83, tallies: [tally(24, 'tests'), tally(22, 'passed'), tally(1, 'failed'), tally(1, 'skipped')] }),
  )
}

// the patches the two test-run cards share: a field's value in the text color
const TEST_RUN_PATCHES = [retint('D05', 12, 7, 8, 'text'), retint('D05', 13, 7, 8, 'text')]

function serveRun(room: Room): Line[] {
  return run(
    room,
    opening('serve', '~/shape', '14:02:05.118', ['term 2.5.22'], { zone: zone(room) }),
    [
      ev({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: 'http://localhost:4000', clock: '14:02:05.730', duration: 612, fields: [field('network', 'http://192.168.1.24:4000')] }),
      ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: '/area.js', clock: '14:02:07.412', duration: 2, http: 200, bytes: 12400 }),
      ev({
        glyph: 'done',
        kind: 'request',
        verb: 'GET',
        subject: '/api/shapes/search?query=regular-hexagon&limit=50&cursor=eyJpZCI6MTIzLCJ0cyI6MTcyOH0',
        clock: '14:02:10.388',
        duration: 31,
        http: 200,
        bytes: 2400,
      }),
      ev({
        glyph: 'failed',
        kind: 'request',
        verb: 'GET',
        subject: '/api/report',
        clock: '14:03:10.871',
        duration: 12,
        http: 500,
        bytes: 0,
        message: ['A number went past the i64 range while summing 31 rows of report totals'],
        fields: [at('code/report.tree:8:14')],
      }),
    ],
    ev({ subject: 'Stopped', clock: '14:05:01.002', duration: 176000, uptime: true, tallies: [tally(318, 'requests'), tally(1, 'errors', 'error')] }),
  )
}

function serveClosing(at: number, count: number): ReturnType<typeof replace> {
  return replace(
    'D09 D10',
    at,
    count,
    row(x('✗'), ' ', d('serve'), ' ', B('Stopped')),
    row(I, d('14:05:01.002'), d(' ·'), ' ', d('up'), ' ', '2', d('m'), ' ', '56', d('s'), d(' ·'), ' ', '318', ' ', d('requests'), d(' ·'), ' ', '1', ' ', d('error')),
  )
}

function compileProblem(): Event {
  return ev({
    glyph: 'failed',
    kind: 'problem',
    verb: 'check',
    subject: 'There is no task named multipy',
    clock: '14:42:00.300',
    fields: [at('code/area.tree:14:12'), field('fix', 'multipy → multiply')],
    frames: [frame([[14, '    back multipy(side, side)']], [{ line: 14, column: 10, length: 7, label: 'did you mean multiply?' }])],
  })
}

// a stack with its top frame in the user's code and six below it that are not
const EMAIL_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  '    at sendEmail (src/jobs/email.ts:42:17)',
  '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
  '    at async Job.run (node_modules/bullmq/dist/job.js:212:9)',
  '    at async Worker.process (node_modules/bullmq/dist/worker.js:401:3)',
  '    at async Worker.retry (node_modules/bullmq/dist/worker.js:455:7)',
  '    at async Worker.loop (node_modules/bullmq/dist/worker.js:310:11)',
  '    at async Promise.all (index 0)<anonymous>',
]

// the 43 files `pnpm ls --files react-dom` lists: the two the mockup names, and 41 more it summarizes
const REACT_DOM_FILES: [string, string][] = [
  ['cjs/react-dom.development.js', '1.2 MB'],
  ['cjs/react-dom.production.js', '184 kB'],
  ...Array.from({ length: 41 }, (_, at): [string, string] => [`cjs/react-dom-part-${String(at + 3).padStart(2, '0')}.js`, `${at + 3} kB`]),
]

// the three events the machine-output card writes as JSON lines
export function machineEvents(): Event[] {
  return [
    ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: '/shape', source: 'api:1', clock: '14:02:07.412', duration: 18, http: 200, bytes: 84 }),
    ev({
      glyph: 'failed',
      kind: 'lifecycle',
      verb: 'exit',
      subject: 'code 1',
      source: 'api:2',
      clock: '14:02:09.660',
      message: ['A number went past the i64 range'],
      fields: [at('code/report.tree:8:14')],
    }),
    ev({ glyph: 'warning', kind: 'job', verb: 'job', subject: 'send-email', source: 'worker', clock: '14:02:11.020', duration: 3000, facts: ['#4813'], tallies: [tally(1, 'retries', '', 3)] }),
  ]
}

// ---- the cards, in page order ----

export const CARDS: Card[] = [
  {
    caption: 'Legend',
    segments: [
      {
        command: 'term style',
        draw: room =>
          items(room, [
            ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: '/api/shape', source: 'api:1', clock: '14:02:07.412', duration: 18, http: 201, bytes: 84 }),
            ev({
              glyph: 'failed',
              kind: 'request',
              verb: 'GET',
              subject: '/api/report',
              source: 'api:2',
              clock: '14:02:09.660',
              duration: 12,
              http: 500,
              bytes: 0,
              message: ['Total went past the i64 range.'],
              fields: [at('code/report.tree:8:14')],
            }),
          ]),
      },
    ],
    patches: [replace('D02', 7, 9)],
  },
  { caption: 'Light terminal', light: true, segments: [{ command: 'term test', draw: testRun }], patches: TEST_RUN_PATCHES },
  {
    caption: 'No color, ASCII only',
    ascii: true,
    colorless: true,
    segments: [
      {
        command: 'term make',
        draw: room =>
          run(
            room,
            opening('make', '~/shape', '14:42:00.000', ['term 2.5.22'], { tallies: [tally(42, 'files')] }),
            [compileProblem()],
            ev({ subject: 'Build failed', clock: '14:42:00.302', duration: 302, tallies: [tally(42, 'files'), tally(1, 'errors', 'error')] }),
          ),
      },
    ],
    patches: [],
    entry: 'D01',
    whole: [
      plain('$ term make'),
      plain('- make ~/shape'),
      plain('  14:42:00.000 . term 2.5.22 . 42 files'),
      plain('x check There is no task named multipy'),
      plain('  14:42:00.300'),
      plain('  at code/area.tree:14:12'),
      plain('  14 |     back multipy(side, side)'),
      plain('     |          ~~~~~~~ did you mean multiply?'),
      plain('  fix multipy -> multiply'),
      plain('x make Build failed'),
      plain('  14:42:00.302 . 302 ms . 42 files . 1 error'),
    ],
  },
  {
    caption: 'No terminal: CI or a pipe',
    colorless: true,
    segments: [
      {
        command: 'term make --target all',
        draw: room => {
          const rust = ev({ glyph: 'running', verb: 'build', subject: 'rust', source: 'server', clock: '14:42:10.000', tallies: [tally(23, 'files', '', 46)] })

          return run(
            room,
            opening('make', '~/shape', '14:42:00.000', ['term 2.5.22'], { tallies: [tally(4, 'targets')] }),
            [
              ev({ glyph: 'skipped', verb: 'build', subject: 'kotlin', source: 'lib', clock: '14:42:00.005', tallies: [tally(46, 'files')] }),
              ev({ glyph: 'done', verb: 'build', subject: 'typescript', source: 'core', clock: '14:42:00.410', duration: 410, tallies: [tally(46, 'files', '', 46)] }),
              // no terminal: the running step prints a `·` progress item once it has run 10 s, and its final item
              makeProgressItem(rust, T('14:42:00.000'), T('14:42:10.000')),
              ev({ glyph: 'done', verb: 'build', subject: 'rust', source: 'server', clock: '14:42:13.600', duration: 13600, tallies: [tally(46, 'files', '', 46)] }),
            ],
            ev({ subject: 'Targets built', clock: '14:42:13.610', duration: 13600, tallies: [tally(4, 'targets', '', 4), tally(1, 'cached')] }),
          )
        },
      },
    ],
    patches: [],
    entry: 'D06',
    whole: [
      plain('❯ term make --target all'),
      plain('● make ~/shape'),
      plain('  14:42:00.000 · term 2.5.22 · 4 targets'),
      plain('○ build kotlin'),
      plain('  14:42:00.005 · lib · 46 files'),
      plain('✓ build typescript'),
      plain('  14:42:00.410 · core · 410 ms · 46/46 files'),
      plain('● build rust'),
      plain('  14:42:10.000 · server · 10.0 s · 23/46 files'),
      plain('✓ build rust'),
      plain('  14:42:13.600 · server · 13.6 s · 46/46 files'),
      plain('✓ make Targets built'),
      plain('  14:42:13.610 · 13.6 s · 4/4 targets · 1 cached'),
    ],
  },
  {
    caption: 'Services',
    segments: [
      {
        command: 'term style --catalog services',
        draw: room =>
          run(
            room,
            opening('serve', '~/shape', '14:02:05.118', ['term 2.5.22'], { zone: zone(room) }),
            [
              ev({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: 'http://localhost:4000', source: 'api', clock: '14:02:05.730', duration: 612 }),
              ev({ glyph: 'info', kind: 'lifecycle', verb: 'reload', subject: 'code/area.tree changed', source: 'api', clock: '14:02:31.098', duration: 94 }),
              ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: '/api/shape', source: 'api', clock: '14:02:07.412', duration: 18, http: 200, bytes: 84 }),
              ev({ glyph: 'done', kind: 'job', verb: 'job', subject: 'resize-image', source: 'worker', clock: '14:02:08.002', duration: 1200, facts: ['#4812'] }),
              ev({ glyph: 'warning', kind: 'job', verb: 'job', subject: 'send-email', source: 'worker', clock: '14:02:11.020', duration: 3000, facts: ['#4813'], tallies: [tally(1, 'retries', '', 3)] }),
              ev({ glyph: 'done', kind: 'query', verb: 'query', subject: 'select shapes by owner', source: 'db', clock: '14:02:11.400', duration: 4, tallies: [tally(12, 'rows')] }),
              ev({ glyph: 'info', kind: 'health', verb: 'health', subject: 'memory', source: 'api', clock: '14:02:12.000', bytes: 212000000, facts: ['61% of limit'] }),
              ev({ glyph: 'warning', kind: 'health', verb: 'health', subject: 'event loop lag', source: 'api', clock: '14:02:12.000', duration: 120, facts: ['over 100ms'] }),
              ev({ glyph: 'info', verb: 'cache', subject: 'warmed', source: 'worker', clock: '14:02:12.950', tallies: [tally(1204, 'keys')] }),
              ev({
                glyph: 'failed',
                kind: 'lifecycle',
                verb: 'exit',
                subject: 'code 1',
                source: 'api',
                clock: '14:02:13.660',
                message: ['A number went past the i64 range.'],
                fields: [at('code/report.tree:8:14')],
              }),
              ev({ glyph: 'info', kind: 'lifecycle', verb: 'restart', subject: 'api', source: 'api', clock: '14:02:13.661', tallies: [tally(1, 'restarts', '', 5)], fields: [field('wait', '1s')] }),
              makeDateItem(T('00:00:00.002', 4), OFFSET, STANDARD),
              ev({ glyph: 'info', kind: 'lifecycle', verb: 'rotate', subject: 'logs/api.log', clock: T('00:00:00.002', 4), bytes: 48000000 }),
              ev({ glyph: 'info', kind: 'lifecycle', verb: 'stop', subject: 'Draining 2 requests', clock: T('00:14:51.660', 4) }),
            ],
            ev({ subject: 'Stopped', clock: T('00:14:51.903', 4), duration: 36720000, uptime: true, tallies: [tally(31804, 'requests'), tally(1, 'errors', 'error')] }),
          ),
      },
    ],
    patches: [
      replace('D08', 30, 1, row(I, d('00:00:00.002'), d(' ·'), ' ', '48.0', ' ', d('MB'))),
      replace(
        'D09 D10',
        33,
        2,
        row(x('✗'), ' ', d('serve'), ' ', B('Stopped')),
        row(I, d('00:14:51.903'), d(' ·'), ' ', d('up'), ' ', '10', d('h'), ' ', '12', d('m'), d(' ·'), ' ', '31,804', ' ', d('requests'), d(' ·'), ' ', '1', ' ', d('error')),
      ),
    ],
  },
  {
    caption: 'Tasks',
    segments: [
      {
        command: 'term style --catalog tasks',
        draw: room =>
          run(
            room,
            opening('make', '~/shape', '14:42:00.000', ['term 2.5.22'], { tallies: [tally(42, 'files')] }),
            [
              ev({ glyph: 'done', verb: 'resolve', subject: '412 packages', clock: '14:42:00.800', duration: 800 }),
              ev({ glyph: 'done', verb: 'fetch', subject: '37 packages', clock: '14:42:02.900', duration: 2100, bytes: 18400000 }),
              ev({ glyph: 'warning', verb: 'fetch', subject: 'registry.npmjs.org timed out', clock: '14:42:12.900', duration: 10000, tallies: [tally(1, 'tries', '', 3)] }),
              ev({ glyph: 'skipped', verb: 'build', subject: 'kotlin', clock: '14:42:12.905', facts: ['cached'] }),
              ev({ glyph: 'running', kind: 'progress', verb: 'build', subject: 'rust', clock: '14:42:15.800', duration: 2900, tallies: [tally(31, 'files', '', 46)], done: 31, total: 46 }),
              ev({ glyph: 'done', verb: 'test', subject: 'list.test.tree', clock: '14:42:15.830', duration: 30, tallies: [tally(9, 'tests'), tally(9, 'passed')] }),
              ev({ glyph: 'done', verb: 'run', subject: 'core', clock: '14:42:17.230', duration: 1400, facts: ['term make --target ts'] }),
              ev({ glyph: 'failed', verb: 'RUN', subject: 'pnpm build', clock: '14:42:21.230', duration: 4000, exit: 1, facts: ['step 6/7'] }),
              ev({ glyph: 'added', kind: 'change', verb: 'add', subject: 'zod', clock: '14:42:21.235', facts: ['3.24.1'] }),
              ev({ glyph: 'changed', kind: 'change', verb: 'update', subject: 'typescript', clock: '14:42:21.240', facts: [formatChange('5.6.3', '5.9.2', room)] }),
              ev({ glyph: 'removed', kind: 'change', verb: 'remove', subject: 'left-pad', clock: '14:42:21.245', facts: ['1.3.0'] }),
              ev({ glyph: 'asking', kind: 'question', verb: 'ask', subject: 'Overwrite term.tree?', clock: '14:42:21.250', facts: ['y/N'] }),
              ev({ glyph: 'info', verb: 'cache', subject: '39 hits, 3 misses', clock: '14:42:21.254', duration: 4, level: 'debug' }),
            ],
            ev({ subject: 'Build failed', clock: '14:42:21.260', duration: 21300, tallies: [tally(42, 'files'), tally(1, 'errors', 'error'), tally(1, 'warnings', 'warning')] }),
            { verbose: true },
          ),
      },
    ],
    patches: [
      retint('D11', 23, 17, 22, 'dim'),
      replace('D36', 28, 1, row(d('●'), ' ', d('cache'), ' ', d('39 hits, 3 misses'))),
      retint('D12', 29, 17, 18, 'dim'),
    ],
  },
  {
    caption: 'Problems',
    segments: [
      {
        command: 'term style --catalog problems',
        draw: room =>
          items(room, [
            ev({
              glyph: 'failed',
              kind: 'problem',
              verb: 'check',
              subject: 'There is no task named multipy',
              clock: '14:42:00.300',
              fields: [at('code/area.tree:14:12'), field('fix', 'multipy → multiply, term fix applies it')],
              frames: [frame([[14, '    back multipy(side, side)']], [{ line: 14, column: 10, length: 7, label: 'did you mean multiply?' }])],
            }),
            ev({ glyph: 'warning', kind: 'problem', verb: 'check', subject: 'radius is never used', clock: '14:42:00.301', fields: [at('code/knob.tree:6:9')] }),
            ev({
              glyph: 'failed',
              kind: 'problem',
              verb: 'prove',
              subject: 'This read might fall outside its list',
              clock: '14:42:00.341',
              fields: [at('code/average.tree:9:8'), field('want', 'scores has at least 1 element'), field('seen', 'scores is empty')],
            }),
            ev({ glyph: 'warning', kind: 'problem', verb: 'prove', subject: 'sort-keeps-length ran out of time', clock: '14:42:10.341', duration: 10000, facts: ['undecided'] }),
            ev({ glyph: 'failed', kind: 'problem', verb: 'case', subject: 'Average of an empty list', clock: '14:42:10.382', duration: 41, fields: [field('want', '0'), field('gave', '1')] }),
            ev({ glyph: 'failed', kind: 'problem', verb: 'email', subject: 'Unhandled rejection', source: 'worker', clock: '14:42:12.300', quote: EMAIL_STACK }),
            ev({
              glyph: 'failed',
              kind: 'problem',
              verb: 'build',
              subject: 'Swift needs Xcode 16 or later',
              clock: '14:42:12.310',
              fields: [field('looked', '/Applications/Xcode.app'), field('next', 'install Xcode, or build with --target ts,rust')],
            }),
            {
              ...makeCrash('prove', 'Term crashed while checking code/area.tree', '', '.term/crash-2026-10-03-1412.log', T('14:42:12.500'), STANDARD),
              fields: [field('log', '.term/crash-2026-10-03-1412.log', true), field('next', 'term report')],
            },
          ]),
      },
    ],
    patches: [],
  },
  {
    caption: 'Package install',
    segments: [
      {
        command: 'pnpm install',
        draw: room =>
          run(
            room,
            opening('install', '~/shape', '14:42:00.005', ['pnpm 10.4.1']),
            [
              ev({ glyph: 'done', verb: 'resolve', subject: '412 packages', clock: '14:42:00.805', duration: 800 }),
              ev({ glyph: 'done', verb: 'fetch', subject: '37 packages', clock: '14:42:02.905', duration: 2100, bytes: 18400000 }),
              ev({ glyph: 'skipped', verb: 'reuse', subject: '375 packages', clock: '14:42:02.910', facts: ['from the store'] }),
              ev({
                glyph: 'warning',
                kind: 'problem',
                verb: 'peers',
                subject: 'react-dom 19.1.0 wants react 19, found 18.3.1',
                clock: '14:42:02.915',
                fields: [field('via', chain(['app', '@shape/ui', 'react-dom'], room)), field('fix', 'pnpm add react@19')],
              }),
              ev({ glyph: 'added', kind: 'change', verb: 'add', subject: '@cluesurf/term', clock: '14:42:02.920', facts: ['2.5.22'] }),
              ev({ glyph: 'added', kind: 'change', verb: 'add', subject: 'zod', clock: '14:42:02.925', facts: ['3.24.1'] }),
              ev({ glyph: 'changed', kind: 'change', verb: 'update', subject: 'typescript', clock: '14:42:02.930', facts: [formatChange('5.6.3', '5.9.2', room)] }),
              ev({ glyph: 'removed', kind: 'change', verb: 'remove', subject: 'left-pad', clock: '14:42:02.935', facts: ['1.3.0'] }),
            ],
            ev({ subject: '412 packages installed', clock: '14:42:06.335', duration: 3400, tallies: [tally(1, 'warnings', 'warning')] }),
          ),
      },
    ],
    patches: [retint('D11', 18, 17, 22, 'dim'), replace('D09', 21, 1, row(w('▲'), ' ', d('install'), ' ', B('412 packages installed')))],
  },
  {
    caption: 'Container build',
    segments: [
      {
        command: 'docker build -t shape .',
        draw: room =>
          run(
            room,
            opening('build', '~/shape', '14:42:00.005', ['docker 28.1', 'linux/arm64'], { tallies: [tally(7, 'steps')] }),
            [
              ev({ glyph: 'skipped', verb: 'FROM', subject: 'node:22-slim', clock: '14:42:00.010', facts: ['cached', 'step 1'] }),
              ev({ glyph: 'skipped', verb: 'WORKDIR', subject: '/app', clock: '14:42:00.015', facts: ['cached', 'step 2'] }),
              ev({ glyph: 'done', verb: 'COPY', subject: 'package.json pnpm-lock.yaml ./', clock: '14:42:00.115', duration: 100, bytes: 1200, facts: ['step 3'] }),
              ev({ glyph: 'done', verb: 'RUN', subject: 'pnpm install --frozen-lockfile', clock: '14:42:24.215', duration: 24100, facts: ['step 4'] }),
              ev({ glyph: 'done', verb: 'COPY', subject: '. .', clock: '14:42:24.415', duration: 200, bytes: 3400000, facts: ['step 5'] }),
              ev({
                glyph: 'failed',
                verb: 'RUN',
                subject: 'pnpm build',
                clock: '14:42:28.415',
                duration: 4000,
                exit: 1,
                facts: ['step 6'],
                fields: [at('Dockerfile:6'), field('next', 'docker build --target build .')],
                quote: ['> term make --target ts', '✗ check  There is no task named multipy'],
              }),
              ev({ glyph: 'skipped', verb: 'CMD', subject: '["node", "dist/main.js"]', clock: '14:42:28.420', facts: ['skipped', 'step 7'] }),
            ],
            ev({ subject: 'Failed at step 6 of 7', clock: '14:42:58.020', duration: 29600, tallies: [tally(1, 'skipped')] }),
          ),
      },
    ],
    patches: [retint('D14', 14, 26, 30, 'dim')],
  },
  { caption: 'Test run', segments: [{ command: 'term test', draw: testRun }], patches: TEST_RUN_PATCHES },
  {
    caption: 'Planned changes',
    segments: [
      {
        command: 'term migrate --plan',
        draw: room =>
          run(
            room,
            opening('migrate', '~/shape', '14:42:00.005', ['term 2.5.22'], { facts: ['plan only'] }),
            [
              ev({ glyph: 'added', kind: 'change', verb: 'add', subject: 'case triangle', clock: '14:42:00.010', facts: ['code/shape.tree'] }),
              ev({ glyph: 'changed', kind: 'change', verb: 'change', subject: 'link radius', clock: '14:42:00.015', facts: ['code/shape.tree', formatChange('like number', 'like decimal', room)] }),
              ev({ glyph: 'removed', kind: 'change', verb: 'remove', subject: 'task legacy-area', clock: '14:42:00.020', facts: ['code/area.tree'] }),
            ],
            ev({
              subject: '3 changes planned, nothing written',
              clock: '14:42:00.025',
              tallies: [tally(1, 'added'), tally(1, 'changed'), tally(1, 'removed')],
              fields: [field('next', 'term migrate')],
            }),
          ),
      },
    ],
    patches: [],
  },
  {
    caption: 'Live progress',
    segments: [
      {
        command: 'term make --target all',
        draw: room => {
          const head = run(room, opening('make', '~/shape', '14:42:00.000', ['term 2.5.22'], { tallies: [tally(4, 'targets')] }), [], null)
          let region: Region = { items: [], height: 0, drawnAt: -1, turn: 0 }

          for (const one of [
            ev({ glyph: 'done', verb: 'build', subject: 'typescript', source: 'core', clock: '14:42:00.410', duration: 410, tallies: [tally(46, 'files', '', 46)] }),
            ev({ glyph: 'running', kind: 'progress', verb: 'build', subject: 'rust', source: 'server', clock: '14:42:02.900', duration: 2900, tallies: [tally(31, 'files', '', 46)], done: 31, total: 46 }),
            ev({ glyph: 'running', kind: 'progress', verb: 'build', subject: 'swift', source: 'app', clock: '14:42:02.900', duration: 2900, tallies: [tally(12, 'files', '', 46)], done: 12, total: 46 }),
            ev({ glyph: 'skipped', verb: 'build', subject: 'kotlin', source: 'lib', clock: '14:42:00.005', tallies: [tally(46, 'files')], fields: [field('reason', 'Cached, no build needed.')] }),
          ]) {
            region = placeItem(region, one)
          }

          const closing = ev({ glyph: 'running', kind: 'close', verb: 'make', subject: 'Building targets', verdict: true, clock: '14:42:02.900', duration: 2900, tallies: [tally(2, 'targets', '', 4)] })
          // no motion, so the spinner is the static ◐ the mockup shows
          const plan = planFrame(region, [closing], T('14:42:02.900'), true, false, room, true)

          // the opening's blank line when the standard spaces a run (v2); v3 runs straight on
          return [...head, ...(room.standard.layout.spacing ? [blankLine()] : []), ...plan.committed, ...plan.lines]
        },
      },
    ],
    patches: [],
  },
  {
    caption: 'Parallel tasks',
    segments: [
      {
        command: 'term run build --all',
        draw: room =>
          run(
            room,
            opening('run', 'build, in 4 packages', '14:42:00.005', ['term 2.5.22'], { tallies: [tally(3, 'at a time')] }),
            [
              ev({ glyph: 'done', verb: 'build', subject: 'core', clock: '14:42:01.405', duration: 1400, facts: ['term make --target ts'] }),
              ev({
                glyph: 'warning',
                verb: 'build',
                subject: 'ui',
                clock: '14:42:03.305',
                duration: 1900,
                facts: ['term make --target ts'],
                tallies: [tally(1, 'warnings', 'warning')],
                message: ['radius is never used'],
                fields: [at('packages/ui/code/knob.tree:6:9')],
              }),
              ev({
                glyph: 'failed',
                verb: 'build',
                subject: 'server',
                clock: '14:42:05.505',
                duration: 2200,
                exit: 1,
                facts: ['term make --target rust'],
                quote: ['error: linker `cc` not found', 'note: install a C toolchain, e.g. build-essential'],
              }),
              ev({ glyph: 'skipped', verb: 'build', subject: 'app', clock: '14:42:05.510', facts: ['term make --target swift', 'cancelled because server failed'] }),
            ],
            ev({ subject: '2 of 4 packages built', clock: '14:42:08.110', duration: 2600, tallies: [tally(1, 'failed'), tally(1, 'cancelled')] }),
          ),
      },
    ],
    patches: [
      replace('D15', 6, 1, row(I, d('14:42:03.305'), d(' ·'), ' ', '1.90', ' ', d('s'), d(' ·'), ' ', '1', ' ', d('warning'), d(' ·'), ' ', d('term make --target ts'))),
      replace('D15 D14', 10, 1, row(I, d('14:42:05.505'), d(' ·'), ' ', '2.20', ' ', d('s'), d(' ·'), ' ', d('exit'), ' ', x('1'), d(' ·'), ' ', d('term make --target rust'))),
      replace('D37', 14, 2, row(I, d('14:42:05.510'), d(' ·'), ' ', d('term make --target swift'), d(' ·'), ' ', d('cancelled because server failed'))),
    ],
  },
  {
    caption: 'Retries and Ctrl-C',
    segments: [
      {
        command: 'pnpm install',
        draw: room =>
          run(
            room,
            opening('install', '~/shape', '14:42:00.005', ['pnpm 10.4.1']),
            [
              ev({ glyph: 'done', verb: 'resolve', subject: '412 packages', clock: '14:42:00.805', duration: 800 }),
              ev({ glyph: 'warning', verb: 'fetch', subject: 'registry.npmjs.org timed out', clock: '14:42:10.805', duration: 10000, tallies: [tally(1, 'tries', '', 3)] }),
              ev({ glyph: 'warning', verb: 'fetch', subject: 'registry.npmjs.org timed out', clock: '14:42:20.805', duration: 10000, tallies: [tally(2, 'tries', '', 3)] }),
              ev({ glyph: 'done', verb: 'fetch', subject: '37 packages', clock: '14:42:27.105', duration: 6300, bytes: 18400000, tallies: [tally(3, 'tries', '', 3)] }),
              // Ctrl-C stopped the link step: it finished as cancelled, in its place, with its final clock and duration
              ev({ glyph: 'skipped', verb: 'link', subject: 'packages', clock: '14:42:55.705', duration: 28600, tallies: [tally(180, 'packages', '', 412)] }),
            ],
            ev({
              subject: 'Stopped by Ctrl-C',
              clock: '14:42:55.705',
              duration: 27400,
              tallies: [tally(180, 'packages linked', '', 412)],
              message: ['node_modules is incomplete'],
              fields: [field('next', 'pnpm install')],
            }),
            {},
            'interrupted',
          ),
      },
    ],
    patches: [
      replace('D16 D17', 11, 4, row(d('○'), ' ', d('link'), ' ', 'packages'), row(I, d('14:42:55.705'), d(' ·'), ' ', '28.6', ' ', d('s'), d(' ·'), ' ', '180/412', ' ', d('packages'))),
    ],
  },
  {
    caption: 'Quiet, default, verbose',
    segments: [
      {
        command: 'term make --quiet',
        draw: room =>
          run(
            room,
            opening('make', '~/shape', '14:42:00.000', ['term 2.5.22'], { tallies: [tally(42, 'files')] }),
            [
              ev({ glyph: 'done', verb: 'check', subject: '42 files', clock: '14:42:00.300', duration: 300 }),
              ev({ glyph: 'done', verb: 'build', subject: 'typescript', clock: '14:42:00.700', duration: 400 }),
            ],
            ev({ subject: '1 target built', clock: '14:42:00.700', duration: 700 }),
            { quiet: true },
          ),
      },
      {
        command: 'term make',
        draw: room =>
          run(
            room,
            opening('make', '~/shape', '14:42:00.705', ['term 2.5.22'], { tallies: [tally(42, 'files')] }),
            [
              ev({ glyph: 'info', verb: 'config', subject: '~/shape/term.tree', clock: '14:42:00.710', level: 'debug' }),
              ev({ glyph: 'done', verb: 'check', subject: '42 files', clock: '14:42:01.005', duration: 300 }),
              ev({ glyph: 'done', verb: 'build', subject: 'typescript', clock: '14:42:01.405', duration: 400 }),
            ],
            ev({ subject: '1 target built', clock: '14:42:02.105', duration: 700 }),
          ),
      },
      {
        command: 'term make --verbose',
        draw: room =>
          run(
            room,
            opening('make', '~/shape', '14:42:02.110', ['term 2.5.22'], { tallies: [tally(42, 'files')] }),
            [
              ev({ glyph: 'info', verb: 'config', subject: '~/shape/term.tree', clock: '14:42:02.115', level: 'debug' }),
              ev({ glyph: 'info', verb: 'cache', subject: '39 hits, 3 misses', clock: '14:42:02.119', duration: 4, level: 'debug' }),
              ev({ glyph: 'done', verb: 'check', subject: '42 files', clock: '14:42:02.419', duration: 300 }),
              ev({ glyph: 'info', verb: 'emit', subject: 'out/ts', clock: '14:42:02.729', duration: 310, bytes: 188000, tallies: [tally(42, 'files')], level: 'debug' }),
              ev({ glyph: 'done', verb: 'build', subject: 'typescript', clock: '14:42:03.129', duration: 400 }),
            ],
            ev({ subject: '1 target built', clock: '14:42:03.829', duration: 700 }),
            { verbose: true },
          ),
      },
    ],
    patches: [
      replace('D36', 15, 1, row(d('●'), ' ', d('config'), ' ', d('~/shape/term.tree'))),
      replace('D36', 17, 1, row(d('●'), ' ', d('cache'), ' ', d('39 hits, 3 misses'))),
      retint('D12', 18, 17, 18, 'dim'),
      replace('D36', 21, 1, row(d('●'), ' ', d('emit'), ' ', d('out/ts'))),
      replace('D12 D31', 22, 1, row(I, d('14:42:02.729'), d(' ·'), ' ', d('310'), ' ', d('ms'), d(' ·'), ' ', d('188'), ' ', d('kB'), d(' ·'), ' ', d('42'), ' ', d('files'))),
    ],
  },
  {
    caption: 'One server',
    segments: [
      {
        command: 'term serve',
        draw: room =>
          run(
            room,
            opening('serve', '~/shape', '14:02:05.118', ['term 2.5.22'], { zone: zone(room) }),
            [
              ev({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: 'http://localhost:4000', clock: '14:02:05.730', duration: 612, fields: [field('network', 'http://192.168.1.24:4000')] }),
              ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: '/area.js', clock: '14:02:07.412', duration: 2, http: 200, bytes: 12400 }),
              ev({
                glyph: 'done',
                kind: 'request',
                verb: 'GET',
                subject: '/api/shapes/search?query=regular-hexagon&limit=50&cursor=eyJpZCI6MTIzLCJ0cyI6MTcyOH0',
                clock: '14:02:10.388',
                duration: 31,
                http: 200,
                bytes: 2400,
              }),
              ev({ glyph: 'warning', kind: 'request', verb: 'GET', subject: '/favicon.ico', clock: '14:02:12.733', duration: 1, http: 404, bytes: 0 }),
              ev({ glyph: 'info', kind: 'lifecycle', verb: 'watch', subject: 'code/area.tree changed', clock: '14:02:31.004' }),
              ev({ glyph: 'done', verb: 'build', subject: 'typescript', clock: '14:02:31.098', duration: 94 }),
              ev({ glyph: 'warning', kind: 'request', verb: 'POST', subject: '/api/shape', clock: '14:02:44.250', duration: 1800, budget: 1000, http: 201, bytes: 84 }),
              ev({
                glyph: 'failed',
                kind: 'request',
                verb: 'GET',
                subject: '/api/report',
                clock: '14:03:10.871',
                duration: 12,
                http: 500,
                bytes: 0,
                message: ['A number went past the i64 range while summing 31 rows of report totals'],
                fields: [at('code/report.tree:8:14')],
              }),
              makeDateItem(T('00:00:00.002', 4), OFFSET, STANDARD),
              ev({ glyph: 'info', kind: 'lifecycle', verb: 'rotate', subject: 'logs/serve.log', clock: T('00:00:00.002', 4) }),
              ev({ glyph: 'info', kind: 'lifecycle', verb: 'stop', subject: 'Draining 2 requests', clock: T('00:14:51.660', 4) }),
            ],
            ev({ subject: 'Stopped', clock: T('00:14:51.903', 4), duration: 36720000, uptime: true, tallies: [tally(31804, 'requests'), tally(1, 'errors', 'error')] }),
          ),
      },
    ],
    patches: [
      replace(
        'D18',
        18,
        1,
        row(I, d('14:02:44.250'), d(' ·'), ' ', w('1.80'), ' ', w('s'), d(' ·'), ' ', d('HTTP'), ' ', o('201'), d(' ·'), ' ', '84', ' ', d('B')),
        row(I, d('budget'), ' ', '1.00 s'),
      ),
      replace('D37', 21, 2, row(I, 'A number went past the i64 range while summing 31 rows of report totals')),
      replace(
        'D09 D10',
        29,
        2,
        row(x('✗'), ' ', d('serve'), ' ', B('Stopped')),
        row(I, d('00:14:51.903'), d(' ·'), ' ', d('up'), ' ', '10', d('h'), ' ', '12', d('m'), d(' ·'), ' ', '31,804', ' ', d('requests'), d(' ·'), ' ', '1', ' ', d('error')),
      ),
    ],
  },
  {
    caption: 'Several services',
    segments: [
      {
        command: 'term dev',
        draw: room => {
          const lines = run(
            room,
            makeServiceOpening('dev', '~/shape', T('14:02:04.990'), 'term 2.5.22', zone(room), ['api:1', 'api:2', 'web', 'worker'], room),
            [
              ev({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: ':4001', source: 'api:1', clock: '14:02:05.118', duration: 612 }),
              ev({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: ':4002', source: 'api:2', clock: '14:02:05.140', duration: 640 }),
              ev({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: ':3000', source: 'web', clock: '14:02:05.402', duration: 1100 }),
              ev({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: 'queue jobs', source: 'worker', clock: '14:02:05.910', duration: 83 }),
              ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: '/shape', source: 'api:1', clock: '14:02:07.412', duration: 18, http: 200, bytes: 84 }),
              ev({ glyph: 'done', kind: 'job', verb: 'job', subject: 'resize-image', source: 'worker', clock: '14:02:08.002', duration: 1200, facts: ['#4812'] }),
              ev({
                glyph: 'failed',
                kind: 'lifecycle',
                verb: 'exit',
                subject: 'code 1',
                source: 'api:2',
                clock: '14:02:09.660',
                message: ['A number went past the i64 range'],
                fields: [at('code/report.tree:8:14')],
              }),
              ev({ glyph: 'info', kind: 'lifecycle', verb: 'restart', subject: 'api:2', source: 'api:2', clock: '14:02:09.661', tallies: [tally(1, 'restarts', '', 5)], fields: [field('wait', '1s')] }),
              ev({ glyph: 'warning', kind: 'job', verb: 'job', subject: 'send-email', source: 'worker', clock: '14:02:11.020', duration: 3000, facts: ['#4813'], tallies: [tally(1, 'retries', '', 3)] }),
            ],
            null,
          )
          const ups = [
            makeUpItem(':4001', 'api:1', T('14:02:11.300'), 6000, 0, STANDARD),
            makeUpItem(':4002', 'api:2', T('14:02:11.300'), 1000, 1, STANDARD),
            makeUpItem(':3000', 'web', T('14:02:11.300'), 6000, 0, STANDARD),
            makeUpItem('queue jobs', 'worker', T('14:02:11.300'), 6000, 0, STANDARD),
          ]

          return [...lines, ...drawFooter(ups, room, true)]
        },
      },
    ],
    patches: [
      replace('D19', 2, 1, row(I, d('14:02:04.990'), d(' ·'), ' ', d('term 2.5.22'), d(' ·'), ' ', d('PDT, UTC−7'), d(' ·'), ' ', '4', ' ', d('services'))),
      replace('D20', 13, 2, row(o('✓'), ' ', d('job'), ' ', 'resize-image'), row(I, d('14:02:08.002'), d(' ·'), ' ', s('worker'), d(' ·'), ' ', '1.20', ' ', d('s'), d(' ·'), ' ', d('#4812'))),
      replace('D21', 19, 2, row(d('●'), ' ', d('restart'), ' ', 'api:2'), row(I, d('14:02:09.661'), d(' ·'), ' ', '1/5', ' ', d('restarts')), row(I, d('wait'), ' ', '1 s')),
      replace(
        'D20',
        21,
        2,
        row(w('▲'), ' ', d('job'), ' ', 'send-email'),
        row(I, d('14:02:11.020'), d(' ·'), ' ', s('worker'), d(' ·'), ' ', '3.00', ' ', d('s'), d(' ·'), ' ', d('#4813'), d(' ·'), ' ', '1/3', ' ', d('retries')),
      ),
      replace('D22', 25, 1, row(I, d('14:02:11.300'), d(' ·'), ' ', s('api:1'), d(' ·'), ' ', d('up'), ' ', '6.00', ' ', d('s'))),
      replace('D22', 27, 1, row(I, d('14:02:11.300'), d(' ·'), ' ', s('api:2'), d(' ·'), ' ', d('up'), ' ', '1.00', ' ', d('s'), d(' ·'), ' ', '1', ' ', d('restart'))),
      replace('D22', 29, 1, row(I, d('14:02:11.300'), d(' ·'), ' ', s('web'), d(' ·'), ' ', d('up'), ' ', '6.00', ' ', d('s'))),
      replace('D22', 31, 1, row(I, d('14:02:11.300'), d(' ·'), ' ', s('worker'), d(' ·'), ' ', d('up'), ' ', '6.00', ' ', d('s'))),
    ],
  },
  {
    caption: 'Child logs, adapted',
    segments: [
      {
        command: 'term dev --source worker',
        draw: room => {
          const smtp = adaptLine(
            '{"level":"warn","logger":"smtp","msg":"slow to respond","host":"smtp.mail.local","waited":3000}',
            T('14:02:12.010'),
            OFFSET,
            false,
            room,
          )
          const email = adaptLine(
            JSON.stringify({ level: 'error', logger: 'email', msg: 'Unhandled rejection', time: '2026-10-03T14:02:12.300-07:00', err: { stack: EMAIL_STACK.join('\n') } }),
            T('14:02:12.299'),
            OFFSET,
            false,
            room,
          )

          return run(
            room,
            opening('dev', 'worker', '14:02:04.990', ['term 2.5.22'], { zone: zone(room) }),
            [
              ev({ glyph: 'done', kind: 'job', verb: 'job', subject: 'send-email', source: 'worker', clock: '14:02:11.020', duration: 3000, facts: ['#4813'] }),
              ev({ glyph: 'info', verb: 'cache', subject: 'warmed', source: 'worker', clock: '14:02:11.950', tallies: [tally(1204, 'keys')] }),
              { ...smtp.event, source: 'worker' },
              { ...email.event, source: 'worker' },
              ev({ glyph: 'failed', kind: 'lifecycle', verb: 'exit', subject: 'code 1', source: 'worker', clock: '14:02:12.301' }),
              ev({ glyph: 'info', kind: 'lifecycle', verb: 'restart', subject: 'worker', source: 'worker', clock: '14:02:12.302', tallies: [tally(2, 'restarts', '', 5)], fields: [field('wait', '2s')] }),
            ],
            null,
            {},
            '',
            false,
          )
        },
      },
    ],
    patches: [
      replace('D20', 3, 2, row(o('✓'), ' ', d('job'), ' ', 'send-email'), row(I, d('14:02:11.020'), d(' ·'), ' ', '3.00', ' ', d('s'), d(' ·'), ' ', d('#4813'))),
      replace('D23', 8, 2, row(I, d('14:02:12.010')), row(I, d('host'), ' ', 'smtp.mail.local'), row(I, d('waited'), ' ', '3000')),
      replace('D21', 17, 2, row(d('●'), ' ', d('restart'), ' ', 'worker'), row(I, d('14:02:12.302'), d(' ·'), ' ', '2/5', ' ', d('restarts')), row(I, d('wait'), ' ', '2 s')),
      replace('D02', 19, 3),
    ],
  },
  {
    caption: 'Machine output',
    data: true,
    segments: [],
    patches: [],
    entry: 'D07',
    whole: [
      plain('❯ term dev --log json'),
      plain(
        '{"glyph":"done","verb":"GET","subject":"/shape","source":"api:1","time":"2026-10-03T14:02:07.412-07:00","ms":18,"status":200,"bytes":84,"kind":"request"}',
      ),
      plain(
        '{"glyph":"failed","verb":"exit","subject":"code 1","source":"api:2","time":"2026-10-03T14:02:09.660-07:00","message":"A number went past the i64 range","fields":{"file":"code/report.tree:8:14"},"kind":"lifecycle"}',
      ),
      plain(
        '{"glyph":"warning","verb":"job","subject":"send-email","source":"worker","time":"2026-10-03T14:02:11.020-07:00","ms":3000,"counts":{"retries":1,"retries_total":3},"facts":["#4813"],"kind":"job"}',
      ),
    ],
  },
  { caption: '120 columns', segments: [{ command: 'term serve', draw: serveRun }], patches: [serveClosing(14, 2)] },
  {
    caption: '60 columns',
    segments: [{ command: 'term serve', draw: serveRun }],
    patches: [
      replace('D38', 8, 2, row(o('✓'), ' ', d('GET'), ' ', '/api/shapes/search?query=regular-hexagon&limit=50&'), row(I, 'cursor=eyJpZCI6MTIzLCJ0cyI6MTcyOH0')),
      replace('D39', 13, 2, row(I, 'A number went past the i64 range while summing 31 rows of'), row('    ', 'report totals')),
      serveClosing(16, 2),
    ],
  },
  {
    caption: '44 columns',
    segments: [{ command: 'term serve', draw: serveRun }],
    patches: [
      replace('D37', 2, 2, row(I, d('14:02:05.118'), d(' ·'), ' ', d('term 2.5.22'), d(' ·'), ' ', d('PDT, UTC−7'))),
      replace('D37', 8, 2, row(I, d('14:02:07.412'), d(' ·'), ' ', '2', ' ', d('ms'), d(' ·'), ' ', d('HTTP'), ' ', o('200'), d(' ·'), ' ', '12.4', ' ', d('kB'))),
      replace('D38', 12, 2, row(I, 'cursor=eyJpZCI6MTIzLCJ0cyI6MTcyOH0')),
      replace('D37', 14, 2, row(I, d('14:02:10.388'), d(' ·'), ' ', '31', ' ', d('ms'), d(' ·'), ' ', d('HTTP'), ' ', o('200'), d(' ·'), ' ', '2.4', ' ', d('kB'))),
      replace('D37', 17, 2, row(I, d('14:03:10.871'), d(' ·'), ' ', '12', ' ', d('ms'), d(' ·'), ' ', d('HTTP'), ' ', x('500'), d(' ·'), ' ', '0', ' ', d('B'))),
      replace('D39', 19, 3, row(I, 'A number went past the i64 range while'), row('    ', 'summing 31 rows of report totals')),
      replace(
        'D09 D10 D32',
        23,
        3,
        row(x('✗'), ' ', d('serve'), ' ', B('Stopped')),
        row(I, d('14:05:01.002'), d(' ·'), ' ', d('up'), ' ', '2', d('m'), ' ', '56', d('s'), d(' ·'), ' ', '318', ' ', d('requests')),
        row(I, '1', ' ', d('error')),
      ),
    ],
  },
  {
    caption: 'Long values at 80 columns',
    segments: [
      {
        command: 'term dev',
        draw: room =>
          run(
            room,
            makeServiceOpening('dev', '~/shape', T('14:02:04.990'), 'term 2.5.22', zone(room), ['api', 'payments-reconciler'], room),
            [
              ev({
                glyph: 'done',
                kind: 'request',
                verb: 'GET',
                subject: '/files/sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
                source: 'api',
                clock: '14:02:07.412',
                duration: 48,
                http: 200,
                bytes: 1200000,
              }),
              ev({
                glyph: 'failed',
                kind: 'job',
                verb: 'job',
                subject: 'invoice 99231',
                source: 'payments-reconciler',
                clock: '14:02:08.120',
                duration: 2400,
                message: [
                  'Could not reconcile invoice 99231 against the ledger because the ledger entry for 2026-09-30 was missing.',
                  'A retry is scheduled. No money moved.',
                ],
                fields: [
                  at('services/payments/reconciler/src/jobs/reconcile-invoice.ts:118:22'),
                  field('ledger', 'https://ledger.internal.shape.dev/accounts/acct_7Q2/entries?from=2026-09-30&to=2026-10-01'),
                ],
                quote: [
                  'Error: ledger entry not found (acct_7Q2, 2026-09-30) while running the nightly reconciliation pass',
                  'at reconcile (src/jobs/reconcile-invoice.ts:118:22)',
                ],
              }),
            ],
            null,
          ),
      },
    ],
    patches: [
      replace(
        'D26',
        2,
        1,
        row(I, d('14:02:04.990'), d(' ·'), ' ', d('term 2.5.22'), d(' ·'), ' ', d('PDT, UTC−7'), d(' ·'), ' ', '2', ' ', d('services')),
        row(I, d('sources'), ' ', 'api, payments-reconciler'),
      ),
      replace('D38', 4, 3, row(I, 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')),
      replace('D27', 9, 1, row(I, d('14:02:08.120'), d(' ·'), ' ', s('paymen…ciler'), d(' ·'), ' ', '2.40', ' ', d('s'))),
      replace('D39', 10, 2, row(I, 'Could not reconcile invoice 99231 against the ledger because the ledger entry'), row('    ', 'for 2026-09-30 was missing.')),
      // one space after `at`, not padded to `ledger`, so the location fits beside its key
      replace('D37', 13, 2, row(I, d('at'), ' ', 'services/payments/reconciler/src/jobs/reconcile-invoice.ts:118:22')),
      // a value that does not fit starts beside its key and goes on 2 past it (the user's choice, 2026-10-05)
      replace('D37 D39', 15, 3, row(I, d('ledger'), ' ', 'https://ledger.internal.shape.dev/accounts/acct_7Q2/entries?'), row('    ', 'from=2026-09-30&to=2026-10-01')),
      replace(
        'D37',
        18,
        3,
        row(I, d('⇒ '), 'Error: ledger entry not found (acct_7Q2, 2026-09-30) while running the'),
        row('      ', 'nightly reconciliation pass'),
        row('    ', 'at reconcile (src/jobs/reconcile-invoice.ts:118:22)'),
      ),
    ],
  },
  {
    caption: 'Compile errors',
    segments: [
      {
        command: 'term make',
        draw: room =>
          run(
            room,
            opening('make', '~/shape', '14:42:00.005', ['term 2.5.22'], { tallies: [tally(42, 'files')] }),
            [
              ev({
                glyph: 'failed',
                kind: 'problem',
                verb: 'check',
                subject: 'There is no task named multipy',
                clock: '14:42:00.010',
                fields: [at('code/area.tree:14:12'), field('fix', 'multipy → multiply, term fix applies it')],
                frames: [
                  frame(
                    [
                      [13, '  case square'],
                      [14, '    back multipy(side, side)'],
                    ],
                    [{ line: 14, column: 10, length: 7, label: 'did you mean multiply?' }],
                  ),
                ],
              }),
              ev({
                glyph: 'failed',
                kind: 'problem',
                verb: 'check',
                subject: 'This gives a text where a number is expected',
                clock: '14:42:00.015',
                fields: [at('code/area.tree:9:12')],
                frames: [
                  frame(
                    [
                      [3, 'like number'],
                      [9, '    back "circle"'],
                    ],
                    [
                      { line: 3, column: 1, length: 11, label: 'area says it gives back a number', primary: false },
                      { line: 9, column: 10, length: 8, label: 'this is a text' },
                    ],
                  ),
                ],
              }),
            ],
            ev({ subject: '2 errors in 42 files', clock: '14:42:00.315', duration: 300 }),
          ),
      },
    ],
    patches: [
      replace('D28', 4, 1, row(I, d('14:42:00.010')), row(I, d('at'), ' ', 'code/area.tree:14:12')),
      replace('D28', 10, 1, row(I, d('14:42:00.015')), row(I, d('at'), ' ', 'code/area.tree:9:12')),
    ],
  },
  {
    caption: 'A proof that does not hold',
    segments: [
      {
        command: 'term hold',
        draw: room =>
          run(
            room,
            opening('hold', '~/shape', '14:42:00.005', ['term 2.5.22'], { tallies: [tally(2, 'files'), tally(1, 'obligations', 'obligation')] }),
            [
              ev({
                glyph: 'failed',
                kind: 'problem',
                verb: 'prove',
                subject: 'This read might fall outside its list',
                clock: '14:42:00.010',
                fields: [
                  at('code/average.tree:9:8'),
                  field('want', 'scores has at least 1 element'),
                  field('seen', 'scores is make list, with nothing in it'),
                  field('why', 'first reads position 0, code/list.tree:4:8'),
                  field('next', 'add an assumption that the list is not empty, or weaken the claim'),
                ],
                frames: [
                  frame(
                    [
                      [8, 'host scores, make list'],
                      [9, 'back first(scores)'],
                    ],
                    [{ line: 9, column: 6, length: 13, label: 'scores is empty here' }],
                  ),
                ],
              }),
            ],
            ev({ subject: '0 of 1 obligation proven', clock: '14:42:00.051', duration: 41 }),
          ),
      },
    ],
    patches: [
      replace('D28', 4, 1, row(I, d('14:42:00.010')), row(I, d('at'), ' ', 'code/average.tree:9:8')),
      replace('D37', 11, 2, row(I, d('next'), ' ', 'add an assumption that the list is not empty, or weaken the claim')),
    ],
  },
  {
    caption: 'Theorems',
    segments: [
      {
        command: 'term hold proofs/',
        draw: room =>
          run(
            room,
            opening('hold', 'proofs/', '14:42:00.005', ['term 2.5.22'], { tallies: [tally(4, 'theorems')] }),
            [
              ev({ glyph: 'done', verb: 'prove', subject: 'add-zero', clock: '14:42:00.205', duration: 200, facts: ['add.tree'] }),
              ev({ glyph: 'done', verb: 'prove', subject: 'add-succ', clock: '14:42:00.505', duration: 300, facts: ['add.tree'] }),
              ev({
                glyph: 'failed',
                kind: 'problem',
                verb: 'prove',
                subject: 'add-comm: this rewrite changes nothing',
                clock: '14:42:00.605',
                duration: 100,
                fields: [at('proofs/add.tree:11:7'), field('goal', 'add(succ(n), 0) = succ(n)'), field('have', 'ih : add(n, 0) = n'), field('next', 'rewrite add-succ first, then ih')],
                frames: [frame([[11, 'rewrite add-zero']], [{ line: 11, column: 1, length: 16, label: 'matches nothing in the goal' }])],
              }),
              ev({
                glyph: 'warning',
                kind: 'problem',
                verb: 'prove',
                subject: 'sort-keeps-length ran out of time',
                clock: '14:42:10.605',
                duration: 10000,
                facts: ['undecided'],
                fields: [at('proofs/sort.tree:22:5'), field('next', 'raise the limit with --budget 30s')],
              }),
            ],
            ev({ subject: '2 of 4 theorems proven', clock: '14:42:21.205', duration: 10600, tallies: [tally(1, 'failed'), tally(1, 'undecided')] }),
          ),
      },
    ],
    patches: [
      replace('D28', 8, 1, row(I, d('14:42:00.605'), d(' ·'), ' ', '100', ' ', d('ms')), row(I, d('at'), ' ', 'proofs/add.tree:11:7')),
      replace('D28', 15, 1, row(I, d('14:42:10.605'), d(' ·'), ' ', '10.0', ' ', d('s'), d(' ·'), ' ', d('undecided')), row(I, d('at'), ' ', 'proofs/sort.tree:22:5')),
    ],
  },
  {
    caption: 'Toolchain failures',
    segments: [
      {
        command: 'term make --target ts,rust,swift,kotlin',
        draw: room =>
          run(
            room,
            opening('make', '~/shape', '14:42:00.005', ['term 2.5.22'], { tallies: [tally(42, 'files'), tally(4, 'targets')] }),
            [
              ev({ glyph: 'done', verb: 'build', subject: 'typescript', clock: '14:42:00.405', duration: 400 }),
              ev({ glyph: 'done', verb: 'build', subject: 'rust', clock: '14:42:03.505', duration: 3100 }),
              ev({
                glyph: 'failed',
                kind: 'problem',
                verb: 'build',
                subject: 'swift: Xcode 16 or later is needed, and none was found',
                clock: '14:42:03.510',
                fields: [field('looked', '/Applications/Xcode.app, xcode-select -p'), field('next', 'install Xcode, or build with --target ts,rust,kotlin')],
              }),
              ev({
                glyph: 'failed',
                kind: 'problem',
                verb: 'build',
                subject: 'kotlin: the compiler rejected the code Term generated',
                clock: '14:42:04.710',
                duration: 1200,
                fields: [at('code/area.tree:4:3'), field('next', 'this is a bug in Term, not your code; term report files it')],
                frames: [frame([[4, 'sift s']], [{ line: 4, column: 1, length: 6, label: 'generated from here' }])],
                quote: ["out/kotlin/Area.kt:12:5: 'when' expression must be exhaustive"],
              }),
            ],
            ev({ subject: '2 of 4 targets built', clock: '14:42:08.310', duration: 3600 }),
          ),
      },
    ],
    patches: [replace('D28', 12, 1, row(I, d('14:42:04.710'), d(' ·'), ' ', '1.20', ' ', d('s')), row(I, d('at'), ' ', 'code/area.tree:4:3'))],
  },
  {
    caption: 'Internal crash',
    segments: [
      {
        command: 'term hold',
        draw: room =>
          run(
            room,
            opening('hold', '~/shape', '14:42:00.005', ['term 2.5.22'], { tallies: [tally(12, 'files')] }),
            [
              {
                ...makeCrash('prove', 'Term crashed while checking code/area.tree', 'kernel/unify, unexpected meta ?17', '.term/crash-2026-10-03-1412.log', T('14:42:00.205'), STANDARD),
                duration: 200,
                fields: [
                  field('in', 'kernel/unify, unexpected meta ?17'),
                  field('log', '.term/crash-2026-10-03-1412.log', true),
                  field('next', 'this is a bug in Term and your code may be fine; term report files it'),
                ],
              },
            ],
            ev({ subject: 'Stopped by an internal error', clock: '14:42:00.405', duration: 200 }),
            {},
            'bug',
          ),
      },
    ],
    patches: [replace('D37', 7, 3, row(I, d('next'), ' ', 'this is a bug in Term and your code may be fine; term report files it'))],
  },
  {
    caption: 'Long and nested paths',
    segments: [
      {
        command: 'term make',
        draw: room =>
          run(
            room,
            opening('make', 'packages/geometry/src/shapes/', '14:42:00.005', ['term 2.5.22'], { tallies: [tally(3, 'files')] }),
            [
              ev({ glyph: 'done', verb: 'check', subject: 'polygons/regular/triangle.tree', clock: '14:42:00.105', duration: 100 }),
              ev({
                glyph: 'failed',
                kind: 'problem',
                verb: 'check',
                subject: 'There is no task named multipy',
                clock: '14:42:00.205',
                duration: 100,
                fields: [at('packages/geometry/src/shapes/polygons/regular/hexagon.tree:14:12')],
              }),
              ev({ glyph: 'done', verb: 'check', subject: 'round/circle.tree', clock: '14:42:00.305', duration: 100 }),
            ],
            ev({ subject: '1 error in 3 files', clock: '14:42:00.605', duration: 300 }),
          ),
      },
      {
        command: 'pnpm why react',
        draw: room =>
          run(
            room,
            opening('why', 'react', '14:42:00.610', ['pnpm 10.4.1']),
            [
              ev({ glyph: 'info', verb: 'path', subject: chain(['app', '@shape/ui', 'react-dom 19.1.0', 'react 18.3.1'], room), clock: '14:42:00.615' }),
              ev({
                glyph: 'info',
                verb: 'path',
                subject: chain(['app', '@shape/charts', 'victory', 'd3', 'react-smooth', 'react-reconciler 0.29.0', 'react 18.3.1'], room),
                clock: '14:42:00.620',
              }),
            ],
            null,
          ),
      },
      {
        command: 'pnpm ls --files react-dom',
        draw: room =>
          run(
            room,
            opening('files', 'react-dom 19.1.0', '14:42:00.625', [], {
              tallies: [tally(43, 'files')],
              facts: ['store: node_modules/.pnpm/react-dom@19.1.0/'],
              entries: REACT_DOM_FILES.map(([label, detail]) => ({ label, detail })),
            }),
            [],
            null,
          ),
      },
    ],
    patches: [
      replace(
        'D37',
        17,
        2,
        row(d('●'), ' ', d('path'), ' ', 'app', d(' › '), '@shape/charts', d(' › '), d('… 3 more'), d(' › '), 'react-reconciler 0.29.0', d(' › '), 'react 18.3.1'),
      ),
      replace('D29 D40', 23, 3, ...REACT_DOM_FILES.slice(0, 10).map(([label, detail]) => row(I, `${label.padEnd(28)}  `, d(detail))), row(I, d('… 33 more, --all lists them'))),
    ],
  },
  {
    caption: 'Prompts',
    segments: [
      {
        command: 'term init',
        draw: room => {
          const name: Question = { ...question('text', 'Name', '--name', 'shape'), answered: true, answer: 'shape' }
          const proof: Question = { ...question('pick', 'Proof checks', '', 'on'), answered: true, answer: 'on', choices: [{ label: 'on', hint: '', picked: true, focused: false, value: '' }] }
          const targets: Question = {
            ...question('pick-many', 'Targets', '--target', ''),
            focus: 2,
            choices: [
              { label: 'typescript', hint: '', picked: true, focused: false, value: 'ts' },
              { label: 'rust', hint: '', picked: true, focused: false, value: 'rust' },
              { label: 'swift', hint: 'macOS, iOS simulator', picked: false, focused: false, value: 'swift' },
              { label: 'kotlin', hint: '', picked: false, focused: false, value: 'kotlin' },
            ],
          }
          const overwrite: Question = question('confirm', 'Overwrite term.tree?', '', 'no')

          return run(
            room,
            opening('init', '~/shape', '14:42:00.005', ['term 2.5.22']),
            [
              questionEvent(name, T('14:42:00.010'), STANDARD),
              questionEvent(proof, T('14:42:00.015'), STANDARD),
              questionEvent(targets, T('14:42:00.020'), STANDARD),
              questionEvent(overwrite, T('14:42:00.025'), STANDARD),
            ],
            null,
          )
        },
      },
      {
        command: 'term init < answers.txt',
        draw: room => {
          const questions: Question[] = [
            question('text', 'Name', '--name', 'shape'),
            question('confirm', 'Proof checks', '', 'yes'),
            {
              ...question('pick-many', 'Targets', '--target', ''),
              choices: [
                { label: 'typescript', hint: '', picked: true, focused: false, value: 'ts' },
                { label: 'rust', hint: '', picked: true, focused: false, value: 'rust' },
              ],
            },
            question('confirm', 'Overwrite term.tree?', '', 'no'),
          ]
          const failure = failWithoutTerminal('init', 'term init', questions, T('14:42:00.030'), STANDARD)

          // no terminal: the run opens, and the failure is its closing item, exit 2 (wrong usage: the flags were owed)
          return run(room, opening('init', '~/shape', '14:42:00.025', ['term 2.5.22']), [], { ...failure, duration: 5 }, {}, 'usage')
        },
      },
    ],
    patches: [
      replace('D40', 12, 1, row(I, '◯ kotlin')),
      replace(
        'D30',
        17,
        2,
        row(d('●'), ' ', d('init'), ' ', '~/shape'),
        row(I, d('14:42:00.025'), d(' ·'), ' ', d('term 2.5.22')),
        row(x('✗'), ' ', d('init'), ' ', B('term init needs answers, and this is not a terminal')),
        row(I, d('14:42:00.030'), d(' ·'), ' ', '5', ' ', d('ms')),
      ),
    ],
  },
  {
    caption: 'Key-values, tables, trees',
    segments: [
      {
        command: 'term info',
        draw: room =>
          run(
            room,
            ev({
              kind: 'open',
              verb: 'info',
              subject: 'term 2.5.22',
              clock: '14:42:00.005',
              fields: [field('kernel', '0.9.4'), field('node', '22.11.0'), field('config', '~/shape/term.tree'), field('cache', '~/.term/cache, 212 MB')],
            }),
            [],
            null,
          ),
      },
      {
        command: 'term targets',
        draw: room =>
          run(
            room,
            ev({
              kind: 'open',
              verb: 'targets',
              subject: '6 targets',
              clock: '14:42:00.010',
              tallies: [tally(4, 'stable')],
              columns: [
                { title: 'target', numeric: false },
                { title: 'platform', numeric: false },
                { title: 'state', numeric: false },
                { title: 'files', numeric: true },
              ],
              rows: [
                ['typescript', 'Node, browser, Workers', 'stable', '42'],
                ['swift', 'macOS, iOS simulator', 'stable', '42'],
                ['kotlin', 'Android', 'stable', '42'],
                ['rust', 'Linux, Windows', 'stable', '42'],
                ['wgsl', 'GPU, numbers, arrays', 'experimental', '3'],
                ['hvm', 'the pure fragment', 'experimental', '0'],
              ].map(entries => ({
                entries: entries.map(value => ({ value, role: value === 'experimental' ? 'warning' : 'text', strong: false, href: '', focus: false })),
              })),
            }),
            [],
            null,
          ),
      },
      {
        command: 'term deps --tree',
        draw: room =>
          run(
            room,
            ev({
              kind: 'open',
              verb: 'deps',
              subject: 'shape',
              clock: '14:42:00.015',
              tallies: [tally(4, 'packages')],
              nodes: [node('geometry', '1.4.0', [node('numbers', '0.8.2')]), node('lists', '2.0.1', [node('numbers', '0.8.2', [], true)])],
            }),
            [],
            null,
          ),
      },
    ],
    patches: [
      replace(
        'D40',
        15,
        2,
        row(I, 'wgsl        GPU, numbers, arrays    ', w('experimental'), '      3'),
        row(I, 'hvm         the pure fragment       ', w('experimental'), '      0'),
      ),
    ],
  },
]

function question(kind: string, label: string, flag: string, fallback: string): Question {
  return { kind, label, flag, default: fallback, choices: [], focus: 0, typed: '', answered: false, answer: '' }
}

export { blankEvent, plainSubject }
export type { Expected }
