// `find` reads as a statement and as a value in the code role (note/project/term/find, tasks 0005 and 0062).
//
// The fixtures are the examples of research/find-general-query.md (sections 1 to 12, 13 to 17, 19, 20, 21, 23, 27
// and the SQL and file forms, without `turn` and `depth`) and the two `meet lack` examples of research/meet-lack.md,
// each read through the code role's `flow` rule (the rule a task body uses) and minted. The slot shapes are asserted
// as one line each: `find-query(count=one() base=find-base(...) link=[...] flow=...)`, an empty slot left out. The
// older fixtures of research/find-design.md are kept, with a path that began with `link` now beginning with `base`.
//
// Also held: the shorthand `find pane / have ...` mints EXACTLY what `find one / base pane / have ...` mints, a
// constraint belongs to the `base` or the `link` it is under, a `find` under a `load` is still the import,
// `wait f(x)` is still the await prefix, a `find` in a task body inside a whole file is read by the `code` rule, and
// nothing the grammar read before reads differently.
//
//   npx tsx test/compile/find-grammar.ts          (PRINT=1 prints the shapes to paste into EXPECT)

import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { loadRoleGrammar } from '@term/make/code/compile/mill-load'
import { runMine, runMint } from '@term/make/code/compile/mill-run'
import type { Minted } from '@term/make/code/compile/mill-run'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const MILL = join(HERE, '../../deck/mill/code/tree')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 600)}`)
  }
}

const grammar = loadRoleGrammar(MILL, 'code')

ok('the code grammar loads clean', grammar.problems.length === 0 && grammar.collisions.length === 0, JSON.stringify(grammar.problems))

function show(m: Minted): string {
  if (m.kind === 'word') return m.value
  if (m.kind === 'text') return `"${m.value}"`
  if (m.kind === 'number') return String(m.value)

  const parts: string[] = []

  for (const [key, list] of Object.entries(m.fields)) {
    if (list.length) {
      parts.push(`${key}=${list.length === 1 ? show(list[0]!) : `[${list.map(show).join(' ')}]`}`)
    }
  }

  return `${m.form}(${parts.join(' ')})`
}

// every statement of a source, read through `flow` and minted, one shape each
function shapes(text: string): string[] | undefined {
  const parsed = parse({ file: 'find.tree', text })

  if (!parsed.ok) return undefined

  const out: string[] = []

  for (const group of parsed.tree.nodes) {
    const mined = runMine(grammar.mine, 'flow', { kind: 'root', nodes: [group] })

    if (!mined.ok) return undefined

    for (const captures of mined.match.values()) {
      for (const capture of captures) {
        if (capture.kind !== 'match') continue

        for (const value of runMint(grammar.mint, capture.rule, capture.match, capture.node)) {
          out.push(show(value))
        }
      }
    }
  }

  return out
}

type Fixture = { name: string; source: string }

const FIXTURES: Fixture[] = [
  // ---- research/find-design.md, with a path starting at `base` ----
  { name: '1 find button, click', source: 'find button\n  click' },
  { name: '1 find button, have, click', source: 'find button\n  have text, <Save>\n  click' },
  { name: '1 find button, call click', source: 'find button\n  call click' },
  { name: '2 find one, base, click', source: 'find one\n  base button\n    have text, <Save>\n\n  click' },
  { name: '2 find all, base, click', source: 'find all\n  base button\n    have class, <close>\n\n  click' },
  { name: '3 shorthand window', source: 'find window\n  have title, <Term>\n  focus' },
  { name: '3 explicit window', source: 'find one\n  base window\n    have title, <Term>\n\n  focus' },
  { name: '4 find all, take first', source: 'find all\n  base button\n    have class, <item>\n\n  take first' },
  {
    name: '5 path of three',
    source:
      'find one\n  base window\n    have title, <Term>\n\n  link tab\n    have title, <dev>\n\n  link pane\n    have title, <server>\n\n  click',
  },
  { name: '6 flat links, no haves', source: 'find one\n  base window\n\n  link tab\n\n  link pane' },
  {
    name: '6 nested find',
    source: 'find window\n  find button\n    click',
  },
  { name: '7 find button, click', source: 'find button\n  click' },
  { name: '7 find pane, clear, run', source: 'find pane\n  clear\n  run <npm dev>' },
  {
    name: '8 nested find with have',
    source: 'find window\n  have title, <Term>\n\n  find button\n    have text, <Settings>\n    click',
  },
  {
    name: '8 one path with toolbar',
    source:
      'find one\n  base window\n    have title, <Term>\n\n  link toolbar\n\n  link button\n    have text, <Settings>\n\n  click',
  },
  { name: '9 haves', source: 'find button\n  have text, <Save>\n  have state, enabled\n  click' },
  {
    name: '9 haves under a base and a link',
    source:
      'find one\n  base window\n    have title, <Term>\n\n  link button\n    have text, <Save>\n    have state, enabled\n\n  click',
  },
  { name: '9 index value', source: 'find tab\n  have index, 2\n  have id, <save>\n  focus' },
  {
    name: '10 lack',
    source: 'find all\n  base button\n    have class, <action>\n    lack state, disabled\n\n  click',
  },
  { name: '11 find all, window, tab', source: 'find all\n  base window\n    have title, <Term>\n\n  link tab' },
  {
    name: '11 find all, close',
    source: 'find all\n  base window\n    have title, <Term>\n\n  link tab\n    have state, idle\n\n  close',
  },
  {
    name: '12 find all of find ones',
    source:
      'find all\n  find one\n    base window\n      have title, <Term>\n\n    link tab\n      have title, <dev>\n\n  find one\n    base window\n      have title, <Term>\n\n    link tab\n      have title, <test>\n\n  close',
  },
  {
    name: '12 link like (css)',
    source:
      'find all\n  find one\n    base main\n    link article, like child\n\n  find one\n    base main\n    link aside, like child\n\n  have color, red',
  },
  {
    name: '18 app window tab pane, focus clear run',
    source:
      'find one\n  base app\n    have name, <Terminal>\n\n  link window\n    have title, <Term>\n\n  link tab\n    have title, <dev>\n\n  link pane\n    have title, <server>\n\n  focus\n  clear\n  run <npm dev>',
  },
  { name: '18 trivial case', source: 'find pane\n  have title, <server>\n  run <npm dev>' },
  { name: '19 close test tabs', source: 'find all\n  base tab\n    have title, <test>\n\n  close' },
  {
    name: '19 two named tabs',
    source:
      'find all\n  find one\n    base tab\n      have title, <test>\n\n  find one\n    base tab\n      have title, <debug>\n\n  close',
  },
  {
    name: '19 window then find all',
    source:
      'find window\n  have title, <Term>\n\n  find all\n    base tab\n      have state, idle\n\n    close',
  },
  {
    name: '20 login form',
    source:
      'find form\n  have id, <login>\n\n  find field\n    have name, <email>\n    fill <me@example.com>\n\n  find field\n    have name, <password>\n    fill password\n\n  find button\n    have text, <Sign in>\n    click',
  },
  {
    name: '20 single path',
    source: 'find one\n  base form\n    have id, <login>\n\n  link button\n    have text, <Sign in>\n\n  click',
  },
  { name: '21 find editor', source: 'find editor\n  have file, <src/main.term>\n  focus' },
  { name: '21 find terminal', source: 'find terminal\n  have name, <server>\n  clear\n  run <npm dev>' },
  // ---- the surface of spec section 3.1 ----
  { name: 'S read a tool', source: 'find read wezterm\n  find pane\n    have title, <server>\n    run <npm dev>' },
  { name: 'S name', source: 'find pane, name server\n  have title, <server>\n  focus' },
  { name: 'S wait', source: 'find one\n  base pane\n  wait <10s>\n  click' },
  { name: 'S await prefix stays', source: 'find pane\n  wait delay(ms)\n  click' },
  { name: 'S value, save', source: 'save panes\n  find all\n    base pane\n    wait <2s>' },
  { name: 'S value, one line', source: 'save server, find pane' },
  // ---- research/find-general-query.md ----
  { name: 'g0 AppleScript-style path', source: 'find one\n  base app\n    have name, <Terminal>\n\n  link window\n    have title, <Term>\n\n  link tab\n    have title, <dev>\n\n  focus' },
  { name: 'g1 one', source: 'find one\n  base person\n    have name, <Alice>' },
  { name: 'g1 all', source: 'find all\n  base person\n    have status, <active>' },
  { name: 'g1 some', source: 'find some\n  base person\n    have email, <alice@example.com>' },
  { name: 'g1 some in a value', source: 'save known\n  find some\n    base person\n      have name, <Alice>' },
  { name: 'g2 short form, button', source: 'find button\n  have text, <Save>\n  click' },
  { name: 'g2 explicit form, button', source: 'find one\n  base button\n    have text, <Save>\n\n  click' },
  { name: 'g2 short form, window', source: 'find window\n  have title, <Term>\n  focus' },
  { name: 'g2 explicit form, window', source: 'find one\n  base window\n    have title, <Term>\n\n  focus' },
  { name: 'g2 bare', source: 'find button\n  click' },
  { name: 'g3 base user', source: 'find all\n  base user' },
  { name: 'g3 base user, have', source: 'find all\n  base user\n    have status, <active>' },
  { name: 'g3 base app', source: 'find one\n  base app\n    have name, <Safari>' },
  { name: 'g3 base filesystem', source: 'find all\n  base ./src' },
  { name: 'g3 base collection', source: 'find all\n  base users' },
  { name: 'g4 links are siblings', source: 'find one\n  base app\n    have name, <Terminal>\n\n  link window\n\n  link tab\n\n  link pane' },
  {
    name: 'g5 constraints belong to their component',
    source:
      'find one\n  base app\n    have name, <Terminal>\n\n  link window\n    have title, <Term>\n\n  link tab\n    have title, <dev>\n\n  link pane\n    have title, <server>',
  },
  {
    name: 'g5 database, back',
    source: 'find all\n  base user\n    have status, <active>\n    have role, <admin>\n\n  back name\n  back email',
  },
  {
    name: 'g5 graph',
    source:
      'find all\n  base person\n    have name, <Alice>\n\n  link person, like follows\n    have status, <active>\n\n  back name',
  },
  { name: 'g6 have, state', source: 'find all\n  base button\n    have text, <Save>\n    have state, enabled' },
  { name: 'g7 lack', source: 'find all\n  base person\n    lack status, <banned>' },
  {
    name: 'g8 hold',
    source: 'find all\n  base user\n    hold is-minimum\n      bind a, read self/age\n      bind b, code 18',
  },
  {
    name: 'g8 have and hold in one component',
    source:
      'find all\n  base user\n    have status, <active>\n\n    hold is-minimum\n      bind a, read self/age\n      bind b, code 18',
  },
  {
    name: 'g9 meet and',
    source:
      'find all\n  base user\n    meet and\n      hold is-equal\n        bind a, read self/status\n        bind b, text <active>\n\n      hold is-minimum\n        bind a, read self/score\n        bind b, code 100\n\n  back name',
  },
  { name: 'g10 back, alias', source: 'find all\n  base user\n  back given, read self/first-name' },
  {
    name: 'g10 back, computed',
    source:
      'find all\n  base user\n  back full-name\n    call concat\n      bind a, read self/first-name\n      bind b, read self/last-name',
  },
  {
    name: 'g10 back, aggregate',
    source: 'find all\n  base user\n  back count\n    call count\n      bind a, read self/id',
  },
  { name: 'g11 default return', source: 'find all\n  base user\n    have status, <active>' },
  {
    name: 'g11 projection',
    source: 'find all\n  base user\n    have status, <active>\n\n  back id\n  back name',
  },
  {
    name: 'g12 named query, have',
    source:
      'find all, name users-by-role\n  take role, like text\n  take limit, like u64\n\n  base user\n    have role, read role\n\n  back name\n  back email\n\n  size read limit',
  },
  {
    name: 'g12 named query, hold',
    source:
      'find all, name users-by-role\n  take role, like text\n\n  base user\n    hold is-equal\n      bind a, read self/role\n      bind b, read role\n\n  back name',
  },
  {
    name: 'g13 safari window',
    source:
      'find one\n  base app\n    have name, <Safari>\n\n  link window\n    have title, <GitHub>',
  },
  {
    name: 'g13 click a button',
    source:
      'find one\n  base app\n    have name, <Safari>\n\n  link window\n    have title, <GitHub>\n\n  link button\n    have text, <Reload>\n\n  click',
  },
  {
    name: 'g13 reload by name',
    source:
      'find one\n  base app\n    have name, <Safari>\n\n  link window\n\n  link button\n    have name, <Reload>\n\n  click',
  },
  {
    name: 'g14 windows',
    source:
      'find one\n  base app\n    have name, <Visual Studio Code>\n\n  link window\n\n  link button\n    have name, <Run>\n\n  click',
  },
  {
    name: 'g15 linux',
    source:
      'find one\n  base app\n    have name, <Firefox>\n\n  link window\n\n  link tab\n    have title, <GitHub>\n\n  focus',
  },
  {
    name: 'g16 terminal, three actions',
    source:
      'find one\n  base app\n    have name, <Terminal>\n\n  link window\n    have title, <Term>\n\n  link tab\n    have title, <dev>\n\n  link pane\n    have title, <server>\n\n  focus\n  clear\n  run <npm dev>',
  },
  {
    name: 'g16 terminal as context',
    source:
      'find one\n  base window\n    have title, <Term>\n\n  link tab\n    have title, <dev>\n\n  link pane\n    have title, <server>\n\n  run <npm dev>',
  },
  {
    name: 'g17 contextual nested queries',
    source:
      'find app\n  have name, <Terminal>\n\n  find window\n    have title, <Term>\n\n    find pane\n      have title, <server>\n      clear',
  },
  {
    name: 'g17 one query path',
    source:
      'find one\n  base app\n    have name, <Terminal>\n\n  link window\n    have title, <Term>\n\n  link pane\n    have title, <server>\n\n  clear',
  },
  { name: 'g18 css, one selector', source: 'find one\n  base main\n\n  link article, like child\n    have class, <card>' },
  {
    name: 'g18 css, selector list',
    source:
      'find all\n  find one\n    base main\n    link article, like child\n\n  find one\n    base main\n    link aside, like child\n\n  find one\n    base footer\n    link nav, like child\n\n  have color, red',
  },
  {
    name: 'g19 dom, path',
    source:
      'find one\n  base form\n    have id, <login>\n\n  link field\n    have name, <email>\n\n  fill <me@example.com>',
  },
  {
    name: 'g19 dom, contextual',
    source:
      'find form\n  have id, <login>\n\n  find button\n    have text, <Sign in>\n    click',
  },
  {
    name: 'g20 filesystem',
    source:
      'find all\n  base ./src\n\n  link file\n    have extension, <term>\n\n  back path\n  back size\n\n  sort fall, name size',
  },
  { name: 'g20 filesystem, some', source: 'find some\n  base ./src\n\n  link file\n    have name, <main.term>' },
  { name: 'g20 filesystem, one', source: 'find one\n  base ./src\n\n  link file\n    have name, <main.term>' },
  {
    name: 'g21 database, sort and size',
    source:
      'find all\n  base user\n    have status, <active>\n\n  back name\n  back email\n\n  sort rise, name name\n  size 50',
  },
  {
    name: 'g21 active premium users',
    source:
      'find all, name active-premium-users\n  take min-spend, like u64\n\n  base user\n    meet and\n      hold is-equal\n        bind a, read self/status\n        bind b, text <active>\n\n      hold is-equal\n        bind a, read self/tier\n        bind b, text <premium>\n\n      hold is-above\n        bind a, read self/total-spend\n        bind b, read min-spend\n\n  back id\n  back name\n  back email',
  },
  {
    name: 'g23 node',
    source: 'find one\n  base person\n    have name, <Alice>',
  },
  {
    name: 'g23 outgoing',
    source:
      'find all\n  base person\n    have name, <Alice>\n\n  link person, like follows',
  },
  {
    name: 'g23 two hops',
    source:
      'find all\n  base person\n    have name, <Alice>\n\n  link person, like follows\n\n  link person, like follows\n\n  back name',
  },
  {
    name: 'g23 intermediate nodes',
    source:
      'find all\n  base person\n    have name, <Alice>\n\n  link person, like follows\n    have status, <active>\n\n  link company, like works-at\n    have country, <US>\n\n  back name',
  },
  {
    name: 'g23 existence',
    source:
      'find some\n  base person\n    have name, <Alice>\n\n  link person, like follows\n    have name, <Bob>',
  },
  {
    name: 'g24 explicit edge',
    source:
      'find all\n  base person\n    have name, <Alice>\n\n  link follows\n    hold is-minimum\n      bind a, read self/since\n      bind b, code 2024\n\n  link person\n    have status, <active>\n\n  back name',
  },
  {
    name: 'g27 sift',
    source:
      'find all\n  base person\n    have name, <Alice>\n\n  link person, like follows\n\n  sift id\n\n  back name',
  },
  {
    name: 'g28 sort, size, head',
    source:
      'find all\n  base person\n    have name, <Alice>\n\n  link person, like follows\n\n  back name\n  back score\n\n  sort fall, name score\n  size 10\n  head 100',
  },
  {
    name: 'g28 files',
    source: 'find all\n  base ./src\n\n  link file\n\n  sort fall, name modified-at\n  size 20',
  },
  // ---- research/meet-lack.md ----
  {
    name: 'ml meet lack over a hold',
    source:
      'find all\n  base user\n    meet lack\n      hold is-equal\n        bind a, read self/status\n        bind b, text <banned>',
  },
  {
    name: 'ml meet lack over meet or',
    source:
      'find all\n  base user\n    meet lack\n      meet or\n        hold is-equal\n          bind a, read self/role\n          bind b, text <admin>\n\n        hold is-equal\n          bind a, read self/role\n          bind b, text <owner>',
  },
  {
    name: 'ml meet lack, nested under a link',
    source:
      'find all\n  base person\n\n  link person, like follows\n    meet lack\n      have status, <banned>',
  },
]

// the minted shapes of the fixtures above, frozen from a run on 2026-10-06 and read by hand against the sources
const EXPECT: Record<string, string> = {
  "1 find button, click": "find-query(count=one() base=find-base(kind=button) flow=click)",
  "1 find button, have, click": "find-query(count=one() base=find-base(kind=button have=find-have(mode=have name=text bond=\"Save\")) flow=click)",
  "1 find button, call click": "find-query(count=one() base=find-base(kind=button) flow=call(name=click))",
  "2 find one, base, click": "find-query(count=one() base=find-base(kind=button have=find-have(mode=have name=text bond=\"Save\")) flow=click)",
  "2 find all, base, click": "find-query(count=all() base=find-base(kind=button have=find-have(mode=have name=class bond=\"close\")) flow=click)",
  "3 shorthand window": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) flow=focus)",
  "3 explicit window": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) flow=focus)",
  "4 find all, take first": "find-query(count=all() base=find-base(kind=button have=find-have(mode=have name=class bond=\"item\")) flow=seed-call-open(seed=first name=take))",
  "5 path of three": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) link=[find-link(kind=tab have=find-have(mode=have name=title bond=\"dev\")) find-link(kind=pane have=find-have(mode=have name=title bond=\"server\"))] flow=click)",
  "6 flat links, no haves": "find-query(count=one() base=find-base(kind=window) link=[find-link(kind=tab) find-link(kind=pane)])",
  "6 nested find": "find-query(count=one() base=find-base(kind=window) flow=find-query(count=one() base=find-base(kind=button) flow=click))",
  "7 find button, click": "find-query(count=one() base=find-base(kind=button) flow=click)",
  "7 find pane, clear, run": "find-query(count=one() base=find-base(kind=pane) flow=[clear seed-call-open(seed=\"npm dev\" name=run)])",
  "8 nested find with have": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) flow=find-query(count=one() base=find-base(kind=button have=find-have(mode=have name=text bond=\"Settings\")) flow=click))",
  "8 one path with toolbar": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) link=[find-link(kind=toolbar) find-link(kind=button have=find-have(mode=have name=text bond=\"Settings\"))] flow=click)",
  "9 haves": "find-query(count=one() base=find-base(kind=button have=[find-have(mode=have name=text bond=\"Save\") find-have(mode=have name=state bond=enabled)]) flow=click)",
  "9 haves under a base and a link": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) link=find-link(kind=button have=[find-have(mode=have name=text bond=\"Save\") find-have(mode=have name=state bond=enabled)]) flow=click)",
  "9 index value": "find-query(count=one() base=find-base(kind=tab have=[find-have(mode=have name=index bond=2) find-have(mode=have name=id bond=\"save\")]) flow=focus)",
  "10 lack": "find-query(count=all() base=find-base(kind=button have=[find-have(mode=have name=class bond=\"action\") find-have(mode=lack name=state bond=disabled)]) flow=click)",
  "11 find all, window, tab": "find-query(count=all() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) link=find-link(kind=tab))",
  "11 find all, close": "find-query(count=all() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) link=find-link(kind=tab have=find-have(mode=have name=state bond=idle)) flow=close)",
  "12 find all of find ones": "find-query(count=all() flow=[find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) link=find-link(kind=tab have=find-have(mode=have name=title bond=\"dev\"))) find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) link=find-link(kind=tab have=find-have(mode=have name=title bond=\"test\"))) close])",
  "12 link like (css)": "find-query(count=all() have=find-have(mode=have name=color bond=red) flow=[find-query(count=one() base=find-base(kind=main) link=find-link(kind=article like=child)) find-query(count=one() base=find-base(kind=main) link=find-link(kind=aside like=child))])",
  "18 app window tab pane, focus clear run": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Terminal\")) link=[find-link(kind=window have=find-have(mode=have name=title bond=\"Term\")) find-link(kind=tab have=find-have(mode=have name=title bond=\"dev\")) find-link(kind=pane have=find-have(mode=have name=title bond=\"server\"))] flow=[focus clear seed-call-open(seed=\"npm dev\" name=run)])",
  "18 trivial case": "find-query(count=one() base=find-base(kind=pane have=find-have(mode=have name=title bond=\"server\")) flow=seed-call-open(seed=\"npm dev\" name=run))",
  "19 close test tabs": "find-query(count=all() base=find-base(kind=tab have=find-have(mode=have name=title bond=\"test\")) flow=close)",
  "19 two named tabs": "find-query(count=all() flow=[find-query(count=one() base=find-base(kind=tab have=find-have(mode=have name=title bond=\"test\"))) find-query(count=one() base=find-base(kind=tab have=find-have(mode=have name=title bond=\"debug\"))) close])",
  "19 window then find all": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) flow=find-query(count=all() base=find-base(kind=tab have=find-have(mode=have name=state bond=idle)) flow=close))",
  "20 login form": "find-query(count=one() base=find-base(kind=form have=find-have(mode=have name=id bond=\"login\")) flow=[find-query(count=one() base=find-base(kind=field have=find-have(mode=have name=name bond=\"email\")) flow=seed-call-open(seed=\"me@example.com\" name=fill)) find-query(count=one() base=find-base(kind=field have=find-have(mode=have name=name bond=\"password\")) flow=seed-call-open(seed=password name=fill)) find-query(count=one() base=find-base(kind=button have=find-have(mode=have name=text bond=\"Sign in\")) flow=click)])",
  "20 single path": "find-query(count=one() base=find-base(kind=form have=find-have(mode=have name=id bond=\"login\")) link=find-link(kind=button have=find-have(mode=have name=text bond=\"Sign in\")) flow=click)",
  "21 find editor": "find-query(count=one() base=find-base(kind=editor have=find-have(mode=have name=file bond=\"src/main.term\")) flow=focus)",
  "21 find terminal": "find-query(count=one() base=find-base(kind=terminal have=find-have(mode=have name=name bond=\"server\")) flow=[clear seed-call-open(seed=\"npm dev\" name=run)])",
  "S read a tool": "find-query(from=seed-read(path=wezterm) flow=find-query(count=one() base=find-base(kind=pane have=find-have(mode=have name=title bond=\"server\")) flow=seed-call-open(seed=\"npm dev\" name=run)))",
  "S name": "find-query(count=one() name=server base=find-base(kind=pane have=find-have(mode=have name=title bond=\"server\")) flow=focus)",
  "S wait": "find-query(count=one() base=find-base(kind=pane) wait=find-wait(value=\"10s\") flow=click)",
  "S await prefix stays": "find-query(count=one() base=find-base(kind=pane) flow=[seed-wait(open=seed-call-open(seed=ms name=delay)) click])",
  "S value, save": "save(name=panes seed=find-query(count=all() base=find-base(kind=pane) wait=find-wait(value=\"2s\")))",
  "S value, one line": "save(name=server seed=find-query(count=one() base=find-base(kind=pane)))",
  "g0 AppleScript-style path": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Terminal\")) link=[find-link(kind=window have=find-have(mode=have name=title bond=\"Term\")) find-link(kind=tab have=find-have(mode=have name=title bond=\"dev\"))] flow=focus)",
  "g1 one": "find-query(count=one() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")))",
  "g1 all": "find-query(count=all() base=find-base(kind=person have=find-have(mode=have name=status bond=\"active\")))",
  "g1 some": "find-query(count=some() base=find-base(kind=person have=find-have(mode=have name=email bond=\"alice@example.com\")))",
  "g1 some in a value": "save(name=known seed=find-query(count=some() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\"))))",
  "g2 short form, button": "find-query(count=one() base=find-base(kind=button have=find-have(mode=have name=text bond=\"Save\")) flow=click)",
  "g2 explicit form, button": "find-query(count=one() base=find-base(kind=button have=find-have(mode=have name=text bond=\"Save\")) flow=click)",
  "g2 short form, window": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) flow=focus)",
  "g2 explicit form, window": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) flow=focus)",
  "g2 bare": "find-query(count=one() base=find-base(kind=button) flow=click)",
  "g3 base user": "find-query(count=all() base=find-base(kind=user))",
  "g3 base user, have": "find-query(count=all() base=find-base(kind=user have=find-have(mode=have name=status bond=\"active\")))",
  "g3 base app": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Safari\")))",
  "g3 base filesystem": "find-query(count=all() base=find-base(kind=./src))",
  "g3 base collection": "find-query(count=all() base=find-base(kind=users))",
  "g4 links are siblings": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Terminal\")) link=[find-link(kind=window) find-link(kind=tab) find-link(kind=pane)])",
  "g5 constraints belong to their component": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Terminal\")) link=[find-link(kind=window have=find-have(mode=have name=title bond=\"Term\")) find-link(kind=tab have=find-have(mode=have name=title bond=\"dev\")) find-link(kind=pane have=find-have(mode=have name=title bond=\"server\"))])",
  "g5 database, back": "find-query(count=all() base=find-base(kind=user have=[find-have(mode=have name=status bond=\"active\") find-have(mode=have name=role bond=\"admin\")]) back=[find-back(name=name) find-back(name=email)])",
  "g5 graph": "find-query(count=all() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")) link=find-link(kind=person like=follows have=find-have(mode=have name=status bond=\"active\")) back=find-back(name=name))",
  "g6 have, state": "find-query(count=all() base=find-base(kind=button have=[find-have(mode=have name=text bond=\"Save\") find-have(mode=have name=state bond=enabled)]))",
  "g7 lack": "find-query(count=all() base=find-base(kind=person have=find-have(mode=lack name=status bond=\"banned\")))",
  "g8 hold": "find-query(count=all() base=find-base(kind=user hold=find-hold(name=is-minimum bind=[bind(seed=seed-read(path=self/age) name=a) bind(seed=seed-code(value=18) name=b)])))",
  "g8 have and hold in one component": "find-query(count=all() base=find-base(kind=user have=find-have(mode=have name=status bond=\"active\") hold=find-hold(name=is-minimum bind=[bind(seed=seed-read(path=self/age) name=a) bind(seed=seed-code(value=18) name=b)])))",
  "g9 meet and": "find-query(count=all() base=find-base(kind=user meet=find-meet(mode=and hold=[find-hold(name=is-equal bind=[bind(seed=seed-read(path=self/status) name=a) bind(seed=seed-text(value=\"active\") name=b)]) find-hold(name=is-minimum bind=[bind(seed=seed-read(path=self/score) name=a) bind(seed=seed-code(value=100) name=b)])])) back=find-back(name=name))",
  "g10 back, alias": "find-query(count=all() base=find-base(kind=user) back=find-back(name=given seed=seed-read(path=self/first-name)))",
  "g10 back, computed": "find-query(count=all() base=find-base(kind=user) back=find-back(name=full-name seed=call(bind=[bind(seed=seed-read(path=self/first-name) name=a) bind(seed=seed-read(path=self/last-name) name=b)] name=concat)))",
  "g10 back, aggregate": "find-query(count=all() base=find-base(kind=user) back=find-back(name=count seed=call(bind=bind(seed=seed-read(path=self/id) name=a) name=count)))",
  "g11 default return": "find-query(count=all() base=find-base(kind=user have=find-have(mode=have name=status bond=\"active\")))",
  "g11 projection": "find-query(count=all() base=find-base(kind=user have=find-have(mode=have name=status bond=\"active\")) back=[find-back(name=id) find-back(name=name)])",
  "g12 named query, have": "find-query(count=all() name=users-by-role take=[find-take(name=role like=text) find-take(name=limit like=u64)] base=find-base(kind=user have=find-have(mode=have name=role bond=seed-read(path=role))) back=[find-back(name=name) find-back(name=email)] size=find-size(seed=seed-read(path=limit)))",
  "g12 named query, hold": "find-query(count=all() name=users-by-role take=find-take(name=role like=text) base=find-base(kind=user hold=find-hold(name=is-equal bind=[bind(seed=seed-read(path=self/role) name=a) bind(seed=seed-read(path=role) name=b)])) back=find-back(name=name))",
  "g13 safari window": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Safari\")) link=find-link(kind=window have=find-have(mode=have name=title bond=\"GitHub\")))",
  "g13 click a button": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Safari\")) link=[find-link(kind=window have=find-have(mode=have name=title bond=\"GitHub\")) find-link(kind=button have=find-have(mode=have name=text bond=\"Reload\"))] flow=click)",
  "g13 reload by name": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Safari\")) link=[find-link(kind=window) find-link(kind=button have=find-have(mode=have name=name bond=\"Reload\"))] flow=click)",
  "g14 windows": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Visual Studio Code\")) link=[find-link(kind=window) find-link(kind=button have=find-have(mode=have name=name bond=\"Run\"))] flow=click)",
  "g15 linux": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Firefox\")) link=[find-link(kind=window) find-link(kind=tab have=find-have(mode=have name=title bond=\"GitHub\"))] flow=focus)",
  "g16 terminal, three actions": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Terminal\")) link=[find-link(kind=window have=find-have(mode=have name=title bond=\"Term\")) find-link(kind=tab have=find-have(mode=have name=title bond=\"dev\")) find-link(kind=pane have=find-have(mode=have name=title bond=\"server\"))] flow=[focus clear seed-call-open(seed=\"npm dev\" name=run)])",
  "g16 terminal as context": "find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) link=[find-link(kind=tab have=find-have(mode=have name=title bond=\"dev\")) find-link(kind=pane have=find-have(mode=have name=title bond=\"server\"))] flow=seed-call-open(seed=\"npm dev\" name=run))",
  "g17 contextual nested queries": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Terminal\")) flow=find-query(count=one() base=find-base(kind=window have=find-have(mode=have name=title bond=\"Term\")) flow=find-query(count=one() base=find-base(kind=pane have=find-have(mode=have name=title bond=\"server\")) flow=clear)))",
  "g17 one query path": "find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond=\"Terminal\")) link=[find-link(kind=window have=find-have(mode=have name=title bond=\"Term\")) find-link(kind=pane have=find-have(mode=have name=title bond=\"server\"))] flow=clear)",
  "g18 css, one selector": "find-query(count=one() base=find-base(kind=main) link=find-link(kind=article like=child have=find-have(mode=have name=class bond=\"card\")))",
  "g18 css, selector list": "find-query(count=all() have=find-have(mode=have name=color bond=red) flow=[find-query(count=one() base=find-base(kind=main) link=find-link(kind=article like=child)) find-query(count=one() base=find-base(kind=main) link=find-link(kind=aside like=child)) find-query(count=one() base=find-base(kind=footer) link=find-link(kind=nav like=child))])",
  "g19 dom, path": "find-query(count=one() base=find-base(kind=form have=find-have(mode=have name=id bond=\"login\")) link=find-link(kind=field have=find-have(mode=have name=name bond=\"email\")) flow=seed-call-open(seed=\"me@example.com\" name=fill))",
  "g19 dom, contextual": "find-query(count=one() base=find-base(kind=form have=find-have(mode=have name=id bond=\"login\")) flow=find-query(count=one() base=find-base(kind=button have=find-have(mode=have name=text bond=\"Sign in\")) flow=click))",
  "g20 filesystem": "find-query(count=all() base=find-base(kind=./src) link=find-link(kind=file have=find-have(mode=have name=extension bond=\"term\")) back=[find-back(name=path) find-back(name=size)] sort=find-sort(order=fall name=size))",
  "g20 filesystem, some": "find-query(count=some() base=find-base(kind=./src) link=find-link(kind=file have=find-have(mode=have name=name bond=\"main.term\")))",
  "g20 filesystem, one": "find-query(count=one() base=find-base(kind=./src) link=find-link(kind=file have=find-have(mode=have name=name bond=\"main.term\")))",
  "g21 database, sort and size": "find-query(count=all() base=find-base(kind=user have=find-have(mode=have name=status bond=\"active\")) back=[find-back(name=name) find-back(name=email)] sort=find-sort(order=rise name=name) size=find-size(seed=50))",
  "g21 active premium users": "find-query(count=all() name=active-premium-users take=find-take(name=min-spend like=u64) base=find-base(kind=user meet=find-meet(mode=and hold=[find-hold(name=is-equal bind=[bind(seed=seed-read(path=self/status) name=a) bind(seed=seed-text(value=\"active\") name=b)]) find-hold(name=is-equal bind=[bind(seed=seed-read(path=self/tier) name=a) bind(seed=seed-text(value=\"premium\") name=b)]) find-hold(name=is-above bind=[bind(seed=seed-read(path=self/total-spend) name=a) bind(seed=seed-read(path=min-spend) name=b)])])) back=[find-back(name=id) find-back(name=name) find-back(name=email)])",
  "g23 node": "find-query(count=one() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")))",
  "g23 outgoing": "find-query(count=all() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")) link=find-link(kind=person like=follows))",
  "g23 two hops": "find-query(count=all() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")) link=[find-link(kind=person like=follows) find-link(kind=person like=follows)] back=find-back(name=name))",
  "g23 intermediate nodes": "find-query(count=all() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")) link=[find-link(kind=person like=follows have=find-have(mode=have name=status bond=\"active\")) find-link(kind=company like=works-at have=find-have(mode=have name=country bond=\"US\"))] back=find-back(name=name))",
  "g23 existence": "find-query(count=some() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")) link=find-link(kind=person like=follows have=find-have(mode=have name=name bond=\"Bob\")))",
  "g24 explicit edge": "find-query(count=all() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")) link=[find-link(kind=follows hold=find-hold(name=is-minimum bind=[bind(seed=seed-read(path=self/since) name=a) bind(seed=seed-code(value=2024) name=b)])) find-link(kind=person have=find-have(mode=have name=status bond=\"active\"))] back=find-back(name=name))",
  "g27 sift": "find-query(count=all() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")) link=find-link(kind=person like=follows) back=find-back(name=name) sift=find-sift(name=id))",
  "g28 sort, size, head": "find-query(count=all() base=find-base(kind=person have=find-have(mode=have name=name bond=\"Alice\")) link=find-link(kind=person like=follows) back=[find-back(name=name) find-back(name=score)] sort=find-sort(order=fall name=score) size=find-size(seed=10) head=find-head(seed=100))",
  "g28 files": "find-query(count=all() base=find-base(kind=./src) link=find-link(kind=file) sort=find-sort(order=fall name=modified-at) size=find-size(seed=20))",
  "ml meet lack over a hold": "find-query(count=all() base=find-base(kind=user meet=find-meet(mode=lack hold=find-hold(name=is-equal bind=[bind(seed=seed-read(path=self/status) name=a) bind(seed=seed-text(value=\"banned\") name=b)]))))",
  "ml meet lack over meet or": "find-query(count=all() base=find-base(kind=user meet=find-meet(mode=lack meet=find-meet(mode=or hold=[find-hold(name=is-equal bind=[bind(seed=seed-read(path=self/role) name=a) bind(seed=seed-text(value=\"admin\") name=b)]) find-hold(name=is-equal bind=[bind(seed=seed-read(path=self/role) name=a) bind(seed=seed-text(value=\"owner\") name=b)])]))))",
  "ml meet lack, nested under a link": "find-query(count=all() base=find-base(kind=person) link=find-link(kind=person like=follows meet=find-meet(mode=lack have=find-have(mode=have name=status bond=\"banned\"))))",
}

const print = process.env.PRINT === '1'

for (const fixture of FIXTURES) {
  const got = shapes(fixture.source)

  if (print) {
    console.log(`  ${JSON.stringify(fixture.name)}: ${JSON.stringify(got?.join('\n'))},`)
    continue
  }

  ok(`${fixture.name} parses`, got !== undefined)
  ok(`${fixture.name} slot shape`, got?.join('\n') === EXPECT[fixture.name], `${got?.join('\n')}`)
}

if (print) process.exit(0)

// ---- the shorthand is the explicit shape ----

const PAIRS: Array<[string, string, string]> = [
  [
    'pane, have, run',
    'find pane\n  have title, <server>\n  run <npm dev>',
    'find one\n  base pane\n    have title, <server>\n  run <npm dev>',
  ],
  ['bare', 'find button\n  click', 'find one\n  base button\n  click'],
  [
    'two haves and a lack',
    'find button\n  have text, <Save>\n  lack state, disabled\n  click',
    'find one\n  base button\n    have text, <Save>\n    lack state, disabled\n  click',
  ],
  [
    'a hold',
    'find user\n  hold is-minimum\n    bind a, read self/age\n    bind b, code 18',
    'find one\n  base user\n    hold is-minimum\n      bind a, read self/age\n      bind b, code 18',
  ],
  [
    'a meet lack',
    'find user\n  meet lack\n    have status, <banned>',
    'find one\n  base user\n    meet lack\n      have status, <banned>',
  ],
  [
    'name, back, wait',
    'find pane, name server\n  have title, <server>\n  back title\n  wait <10s>\n  focus',
    'find one, name server\n  base pane\n    have title, <server>\n  back title\n  wait <10s>\n  focus',
  ],
]

for (const [name, short, explicit] of PAIRS) {
  const a = shapes(short)
  const b = shapes(explicit)

  ok(`shorthand equals explicit: ${name}`, a !== undefined && b !== undefined && a.join('\n') === b.join('\n'), `${a}\n${b}`)
}

// ---- a constraint belongs to the component it is under ----

const owned = shapes(
  'find one\n  base app\n    have name, <Terminal>\n\n  link window\n    have title, <Term>\n\n  link tab\n    have title, <dev>',
)?.[0]

ok(
  'a have under a base is the base\'s, one under a link is that link\'s, none belong to the query',
  owned ===
    'find-query(count=one() base=find-base(kind=app have=find-have(mode=have name=name bond="Terminal")) link=[find-link(kind=window have=find-have(mode=have name=title bond="Term")) find-link(kind=tab have=find-have(mode=have name=title bond="dev"))])',
  `${owned}`,
)

const queryLevel = shapes('find one\n  have title, <Term>\n  base window')?.[0]

ok(
  'a have directly under find one is a slot of the query, not of the base (0010 refuses it)',
  queryLevel?.includes('base=find-base(kind=window)') === true && queryLevel.includes(' have=find-have') === true,
  `${queryLevel}`,
)

const holdOwned = shapes('find all\n  base user\n    hold is-above\n      bind a, read self/age\n      bind b, code 18\n\n  link order\n    have state, <open>')?.[0]

ok(
  'a hold under a base is the base\'s',
  holdOwned?.startsWith('find-query(count=all() base=find-base(kind=user hold=find-hold(name=is-above ') === true &&
    holdOwned.includes('link=find-link(kind=order have=find-have(mode=have name=state bond="open"))') &&
    !holdOwned.includes(') hold=find-hold'),
  `${holdOwned}`,
)

// ---- the rules that must not move ----

function mineWhole(text: string): { ok: boolean; shapes: string[] } {
  const parsed = parse({ file: 'whole.tree', text })

  if (!parsed.ok) return { ok: false, shapes: [] }

  const mined = runMine(grammar.mine, 'code', parsed.tree)

  if (!mined.ok) return { ok: false, shapes: [] }

  const out: string[] = []

  const walkMinted = (m: Minted): void => {
    if (m.kind !== 'form') return
    out.push(m.form)

    for (const list of Object.values(m.fields)) {
      for (const inner of list) walkMinted(inner)
    }
  }

  for (const captures of mined.match.values()) {
    for (const capture of captures) {
      if (capture.kind !== 'match') continue

      for (const value of runMint(grammar.mint, capture.rule, capture.match, capture.node)) {
        walkMinted(value)
      }
    }
  }

  return { ok: true, shapes: out }
}

const imported = mineWhole('load ./x\n  find y\n  find tree z\n  find get, name list-get')

ok('a find under a load is still an import', imported.ok && imported.shapes.includes('load'), imported.shapes.join(','))
ok('a find under a load is never a find-query', !imported.shapes.includes('find-query'), imported.shapes.join(','))

const inTask = mineWhole('task demo\n  find pane\n    have title, <server>\n    run <npm dev>')

ok('a find inside a task body reads under the whole code rule', inTask.ok, inTask.shapes.join(','))
ok('the task body holds a find-query', inTask.shapes.includes('find-query'), inTask.shapes.join(','))

const awaited = shapes('wait delay(ms)')

ok('the await prefix stays the await prefix', awaited?.[0]?.startsWith('seed-wait') === true, `${awaited}`)

const plainCall = shapes('call add\n  read a\n  read b')

ok('a call reads as before', plainCall?.[0]?.startsWith('call(') === true, `${plainCall}`)

// a `sift` match statement in a find body stays the match: only `sift <field>` with nothing under the word is the query's
const siftMatch = shapes('find pane\n  sift read x\n    case a\n      click')

ok('a sift with arms under a find is not the query sift', siftMatch?.[0]?.includes('find-sift') === false, `${siftMatch}`)

// `take first` (no `like`) is still a call to the task `take`
const takeCall = shapes('find pane\n  take first')

ok('take without a like is still a call', takeCall?.[0]?.includes('find-take') === false, `${takeCall}`)

// `want` is not part of the query: it is left alone (trap t010)
const want = shapes('find pane\n  want miss')

ok('want is not a query part', want?.[0]?.includes('find-meet') === false, `${want}`)

// `meet` of any other word is not a find-meet
const meetOther = shapes('find all\n  base user\n    meet xor\n      have a, 1')

ok('meet takes and, or or lack only', meetOther?.[0]?.includes('find-meet') === false, `${meetOther}`)

// what the grammar does NOT read as a find, for the refusals of task 0010 to find (spec section 3.4)
const bare = shapes('find')

ok('a bare `find` is not a find-query', bare?.[0] === 'find', `${bare}`)

const nested = shapes('find one\n  base window\n    link tab')

ok(
  'a link under a base is not read as a base: it is a call to `base` in the body, which 0010 refuses',
  nested?.[0]?.includes('name=base') === true && nested[0].includes('base=find-base') === false,
  `${nested}`,
)

const nestedLink = shapes('find one\n  base window\n  link tab\n    link pane')

ok(
  'a link under a link is not read as a link: it is a call to `link` in the body, which 0010 refuses',
  nestedLink?.[0]?.includes('name=link') === true,
  `${nestedLink}`,
)

const baseUnderShort = shapes('find pane\n  base window')

ok(
  'a base under the shorthand is not read as a base: it is a call to `base`, which 0010 refuses',
  baseUnderShort?.[0]?.includes('name=base') === true,
  `${baseUnderShort}`,
)

console.log(`\nfind-grammar: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
