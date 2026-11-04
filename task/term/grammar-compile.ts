// THE GRAMMAR COMPILER: a mill text grammar compiled to Term, so a reader runs its grammar as code rather than through
// the text grammar engine's interpreter (deck/make/code/compile/mine-text.tree), and reads to the SAME outcome: the same
// match tree, the same `matched`, the same place and the same `expected` when it fails. note/term/mill/04-latex-grammar.md.
//
// What the interpreter does at every step, the compiled grammar did once, here:
//
//   the interpreter                                  the compiled grammar
//   looks a rule up by name, in a hash               calls the rule's own task
//   keys its memo with a text, `{name}@{at}`         keys it with a number, the place times the rule count plus the rule
//   reads a range's bound into code points per test  compares against the code points, written in
//   asks a rule's first characters per alternative  tests the merged intervals, written in
//   builds a step object for every rule it tries     pushes onto one stack the run holds, and cuts it back on a failure
//   builds a node for every rule it reaches          builds none for the rules the grammar's reader never reads
//
// The run is `mark shared` and the stack is its field, so no task writes into a list it was handed: under value
// semantics (D1) such a write would reach a copy. A rule notes how high the stack stood, runs its body, and lifts what
// the body pushed into its own node.
//
// The rules and their first characters are read from the ENGINE the interpreter runs (the grammar's `engine.tree`, as
// the package build emits it), never worked out a second time, so the compiled grammar and the interpreter cannot be
// built from two readings of the grammar. `pnpm term:latex-katex` holds the two equal on every start rule.
//
//   pnpm term:grammar-compile              report what would change
//   pnpm term:grammar-compile --commit     write each compiled grammar
//   pnpm term:grammar-compile --check      write nothing, exit 1 when one is not what its engine compiles to
//
// The engine is the package build's: run `term make --trees` in deck/mill first.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TERM_ROOT } from './root'

const ROOT = TERM_ROOT
const MILL = join(TERM_ROOT, 'deck/mill')

// each grammar compiled: the module holding its engine, the task that makes it, where the compiled grammar goes, and
// the name its tasks and forms are prefixed with
const GRAMMARS = [
  {
    engine: 'host/code/text/latex/engine.ts',
    make: 'latexEngine',
    out: 'code/text/latex/compiled.tree',
    prefix: 'latex',
    source: './mine.tree',
    // the rules the reader starts a run from, the most often first: tested before every other name, so a run's
    // start costs a comparison or two. Any rule may still start a run
    starts: [
      'tokens', 'size-search', 'size-text', 'color-text', 'url-text', 'url-tokens', 'url-protocol', 'url-scheme-name',
      'float-text', 'whole-number', 'column-count', 'integer-text', 'graphic-number', 'data-attributes',
      'graphic-attributes', 'verb-command',
    ],
    // rules the reader never reads by name and never reads the children of: their nodes are not built, and what they
    // matched stands in their parent in their place. Every character of a source reaches one or more of these, so
    // they are most of the nodes a run would build. `latex-grammar-elided` names them, and the check holds the
    // compiled tree equal to the interpreter's with exactly these taken out
    elide: [
      'base-character', 'combining-mark', 'command-letter', 'space-character', 'line-space', 'line-space-run', 'digit',
      'lower-letter', 'latin-letter', 'url-blank', 'verb-line-character',
    ],
  },
]

type Rule = { kind: string; [field: string]: unknown }
type First = { open: boolean; low: number[]; high: number[] }
type Engine = { rules: Map<string, Rule[]>; firsts: Map<string, First>; refused: string[] }

// ---- Term text ----

// a text as the content of a Term text literal, or none when it holds a character a literal should not carry
function literal(text: string): string | undefined {
  let out = ''

  for (const c of text) {
    const code = c.codePointAt(0)!

    if (c === '\\' || c === '<' || c === '>' || c === '{' || c === '}') {
      out += `\\${c}`
    } else if (code === 10) {
      out += '\\n'
    } else if (code === 13) {
      out += '\\r'
    } else if (code === 9) {
      out += '\\t'
    } else if (!/^[\p{L}\p{N}\p{P}\p{S} ]$/u.test(c) || (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xfffe) === 0xfffe) {
      // a control, a mark, a private use or unassigned code point, a noncharacter: spelled as its code point, so
      // nothing invisible or reserved is ever written into a literal any backend has to read
      return undefined
    } else {
      out += c
    }
  }

  return out
}

// a text as a Term expression: the literal, or its code points made into a text when no literal should spell it
function textExpression(text: string, p: string): string {
  const spelled = literal(text)

  if (spelled !== undefined) {
    return `<${spelled}>`
  }

  return `${p}-text-of(make(list, ${[...text].map(c => c.codePointAt(0)).join(', ')}))`
}

function firstCode(text: string): number {
  return text.length === 0 ? -1 : text.codePointAt(0)!
}

// intervals sorted and joined where they meet, which says the same as the interpreter's list and tests faster
function merged(first: First): [number, number][] {
  const pairs = first.low.map((low, k) => [low, first.high[k]] as [number, number]).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []

  for (const [low, high] of pairs) {
    const last = out[out.length - 1]

    if (last && low <= last[1] + 1) {
      last[1] = Math.max(last[1], high)
    } else {
      out.push([low, high])
    }
  }

  return out
}

// whether `code` is in the intervals, as a balanced tree of `or`s so no expression nests deeply
function within(code: string, intervals: [number, number][]): string {
  if (intervals.length === 0) {
    return 'false'
  }

  if (intervals.length === 1) {
    const [low, high] = intervals[0]

    return low === high ? `is-equal(${code}, ${low})` : `and(is-minimum(${code}, ${low}), is-maximum(${code}, ${high}))`
  }

  const half = Math.ceil(intervals.length / 2)

  return `or(${within(code, intervals.slice(0, half))}, ${within(code, intervals.slice(half))})`
}

function anyOf(code: string, codes: number[]): string {
  return within(code, merged({ open: false, low: codes, high: codes }))
}

function indent(lines: string[], by: string): string[] {
  return lines.map(line => `${by}${line}`)
}

// ---- the compiler ----

class Compiler {
  readonly p: string
  readonly engine: Engine
  readonly index = new Map<string, number>()
  readonly tasks: string[][] = []
  readonly elide: Set<string>
  private helpers = 0

  constructor(prefix: string, engine: Engine, elide: string[]) {
    this.p = prefix
    this.engine = engine
    this.elide = new Set(elide)

    for (const name of elide) {
      if (!engine.rules.has(name)) {
        throw new Error(`\`${name}\` is to be elided, and the grammar has no such rule`)
      }
    }

    let k = 0

    for (const name of engine.rules.keys()) {
      this.index.set(name, k++)
    }
  }

  // a run's root is its start rule's node, so a start is never elided
  checkStarts(starts: string[]): void {
    for (const name of starts) {
      if (this.elide.has(name)) {
        throw new Error(`\`${name}\` is a start and cannot be elided: a run's root is its start's node`)
      }
    }
  }

  // a fresh name for a helper task
  helper(): string {
    return `${this.p}-part-${this.helpers++}`
  }

  // Whether an alternative could begin with the character `code`: the interpreter's `could-begin`, decided here
  couldBegin(rule: Rule, code: string): string {
    switch (rule.kind) {
      case 'form': {
        const first = this.engine.firsts.get(rule.name as string)

        return first && !first.open ? within(code, merged(first)) : 'true'
      }
      case 'char':
        return `is-equal(${code}, ${rule.literal})`
      case 'text': {
        const text = rule.literal as string

        return text.length === 0 ? 'true' : `is-equal(${code}, ${firstCode(text)})`
      }
      case 'range':
        return `and(is-minimum(${code}, ${firstCode(rule.base as string)}), is-maximum(${code}, ${firstCode(rule.head as string)}))`
      default:
        return 'true'
    }
  }

  // A sequence as a task of its own: (run, at) to where it ended, -1 when it failed, the stack as it found it. Each
  // part runs from `here` and moves it on, or cuts the stack back to `mark` and fails. `mark` is declared only when a
  // part can fail
  sequence(name: string, rules: Rule[], note: string): void {
    const p = this.p
    const body: string[] = []

    rules.forEach((rule, k) => body.push(...this.part(rule, `${k}`)))

    const lines = [
      `# ${note}`,
      `task ${name}`,
      `  take run, like ${p}-run`,
      '  take at, like number',
      '  like number',
      '  mark private',
      '',
      '  save here, at',
      ...(body.some(line => line.includes(`${p}-cut(run, mark)`)) ? ['  save mark, run/stack/length'] : []),
      ...indent(body, '  '),
      '  back here',
      '',
    ]

    this.tasks.push(lines)
  }

  // what failing does inside a sequence
  get fail(): string[] {
    return [`${this.p}-cut(run, mark)`, 'back -1']
  }

  // a node of `send` over what was pushed since `base`, the captured part of a rule that carries a `send`
  capture(send: string, start: string, end: string, base: string): string[] {
    const p = this.p

    return [`push(run/stack, ${p}-node(${textExpression(send, p)}, ${start}, ${end}, ${p}-lift(run, ${base})))`]
  }

  part(rule: Rule, k: string): string[] {
    const p = this.p
    const fail = this.fail

    switch (rule.kind) {
      case 'form': {
        const name = rule.name as string
        const label = (rule.send as string | undefined) ?? name

        if (!this.index.has(name)) {
          return [...fail]
        }

        return [
          `save e${k}, ${p}-rule-${this.index.get(name)}(run, here, ${textExpression(label, p)})`,
          `fork test, is-below(e${k}, 0)`,
          '  hold',
          ...indent(fail, '    '),
          `save here, e${k}`,
        ]
      }

      case 'char': {
        const send = rule.send as string | undefined
        const out = [
          `fork test, is-unequal(${p}-rune-at(run, here), ${rule.literal})`,
          '  hold',
          `    ${p}-expect-char(run, here, ${rule.literal})`,
          ...indent(fail, '    '),
        ]

        if (send !== undefined) {
          out.push(`push(run/stack, ${p}-node(${textExpression(send, p)}, here, add(here, 1), make(list)))`)
        }

        out.push('save here, add(here, 1)')

        return out
      }

      case 'text': {
        const text = rule.literal as string
        const send = rule.send as string | undefined
        const codes = [...text].map(c => c.codePointAt(0)!)
        const out: string[] = []

        codes.forEach((code, j) => {
          out.push(
            `fork test, is-unequal(${p}-rune-at(run, add(here, ${j})), ${code})`,
            '  hold',
            `    ${p}-expect(run, here, ${textExpression('`' + text + '`', p)})`,
            ...indent(fail, '    '),
          )
        })

        if (send !== undefined) {
          out.push(`push(run/stack, ${p}-node(${textExpression(send, p)}, here, add(here, ${codes.length}), make(list)))`)
        }

        out.push(`save here, add(here, ${codes.length})`)

        return out
      }

      case 'range': {
        const base = rule.base as string
        const head = rule.head as string

        return [
          `save c${k}, ${p}-rune-at(run, here)`,
          `fork test, not(and(is-minimum(c${k}, ${firstCode(base)}), is-maximum(c${k}, ${firstCode(head)})))`,
          '  hold',
          `    ${p}-expect(run, here, ${textExpression('`' + base + '` to `' + head + '`', p)})`,
          ...indent(fail, '    '),
          'save here, add(here, 1)',
        ]
      }

      case 'not': {
        const codes = rule.codes as number[]

        if (codes.length === 0) {
          return []
        }

        return [
          `save c${k}, ${p}-rune-at(run, here)`,
          `fork test, ${anyOf(`c${k}`, codes)}`,
          '  hold',
          ...indent(fail, '    '),
        ]
      }

      case 'until': {
        const send = rule.send as string | undefined
        const out = [
          `save u${k}, here`,
          'walk test',
          `  hook test, and(is-below(u${k}, run/size), is-unequal(${p}-rune-at(run, u${k}), ${rule.terminator}))`,
          '  hook hold',
          `    save u${k}, add(u${k}, 1)`,
        ]

        if (send !== undefined) {
          out.push(`push(run/stack, ${p}-node(${textExpression(send, p)}, here, u${k}, make(list)))`)
        }

        out.push(`save here, u${k}`)

        return out
      }

      case 'send':
        return []

      case 'list': {
        const body = this.helper()

        this.sequence(body, rule.children as Rule[], 'a `list`\'s body')

        return [
          'save run/quiet, add(run/quiet, 1)',
          'walk test',
          '  hook test, true',
          '  hook hold',
          `    save turn${k}, run/stack/length`,
          `    save next${k}, ${body}(run, here)`,
          `    fork test, or(is-below(next${k}, 0), is-equal(next${k}, here))`,
          '      hold',
          `        ${p}-cut(run, turn${k})`,
          '        halt',
          `    save here, next${k}`,
          'save run/quiet, subtract(run/quiet, 1)',
        ]
      }

      case 'optional': {
        const send = rule.send as string | undefined
        const body = this.helper()

        this.sequence(body, rule.children as Rule[], 'a `maybe`\'s body')

        return [
          ...(send !== undefined ? [`save base${k}, run/stack/length`] : []),
          'save run/quiet, add(run/quiet, 1)',
          `save e${k}, ${body}(run, here)`,
          'save run/quiet, subtract(run/quiet, 1)',
          `fork test, is-minimum(e${k}, 0)`,
          '  hold',
          ...(send !== undefined ? indent(this.capture(send, 'here', `e${k}`, `base${k}`), '    ') : []),
          `    save here, e${k}`,
        ]
      }

      case 'mark': {
        const send = rule.send as string | undefined
        const body = this.helper()

        this.sequence(body, rule.children as Rule[], 'a `mark`\'s body')

        return [
          ...(send !== undefined ? [`save base${k}, run/stack/length`] : []),
          `save times${k}, 0`,
          `save reached${k}, here`,
          'walk test',
          `  hook test, is-below(times${k}, ${Math.trunc(rule.width as number)})`,
          '  hook hold',
          `    save e${k}, ${body}(run, reached${k})`,
          `    fork test, is-below(e${k}, 0)`,
          '      hold',
          ...indent(fail, '        '),
          `    save reached${k}, e${k}`,
          `    save times${k}, add(times${k}, 1)`,
          ...(send !== undefined ? this.capture(send, 'here', `reached${k}`, `base${k}`) : []),
          `save here, reached${k}`,
        ]
      }

      case 'span': {
        const body = this.helper()

        this.sequence(body, rule.children as Rule[], 'a span\'s body')

        return [
          `save base${k}, run/stack/length`,
          `save e${k}, ${body}(run, here)`,
          `fork test, is-below(e${k}, 0)`,
          '  hold',
          ...indent(fail, '    '),
          ...this.capture(rule.send as string, 'here', `e${k}`, `base${k}`),
          `save here, e${k}`,
        ]
      }

      case 'any': {
        const send = rule.send as string | undefined
        const tries: string[] = []
        let peeks = false

        for (const alternative of rule.children as Rule[]) {
          let call: string
          const name = alternative.name as string | undefined

          if (alternative.kind === 'form' && name !== undefined && this.index.has(name)) {
            const label = (alternative.send as string | undefined) ?? name

            call = `${p}-rule-${this.index.get(name)}(run, here, ${textExpression(label, p)})`
          } else {
            const body = this.helper()

            this.sequence(body, [alternative], 'one alternative of an `any`')
            call = `${body}(run, here)`
          }

          const could = this.couldBegin(alternative, `code${k}`)

          peeks = peeks || could !== 'true'
          tries.push(
            `fork test, ${could === 'true' ? `is-below(e${k}, 0)` : `and(is-below(e${k}, 0), ${could})`}`,
            '  hold',
            `    save e${k}, ${call}`,
          )
        }

        return [
          ...(peeks ? [`save code${k}, ${p}-rune-at(run, here)`] : []),
          ...(send !== undefined ? [`save base${k}, run/stack/length`] : []),
          `save e${k}, -1`,
          ...tries,
          `fork test, is-below(e${k}, 0)`,
          '  hold',
          ...indent(fail, '    '),
          ...(send !== undefined ? this.capture(send, 'here', `e${k}`, `base${k}`) : []),
          `save here, e${k}`,
        ]
      }

      default:
        throw new Error(`the grammar holds a \`mine ${rule.kind}\`, which the text grammar engine does not run`)
    }
  }

  // One rule, as the interpreter's `match-form` reads it: its first characters are tested, its result is memoized at
  // each place, and on success one node goes onto the stack, labelled as the reference names it, or for an elided rule
  // the nodes it matched
  rule(name: string): void {
    const p = this.p
    const k = this.index.get(name)!
    const first = this.engine.firsts.get(name)
    const body = `${p}-body-${k}`
    const lines = [
      `# \`${name}\``,
      `task ${p}-rule-${k}`,
      `  take run, like ${p}-run`,
      '  take at, like number',
      '  take label, like text',
      '  like number',
      '  mark private',
      '',
    ]

    if (first && !first.open) {
      lines.push(
        `  save first, ${p}-rune-at(run, at)`,
        `  fork test, not(${within('first', merged(first))})`,
        '    hold',
        `      ${p}-expect(run, at, ${textExpression(name, p)})`,
        '      back -1',
      )
    }

    lines.push(
      `  save key, add(multiply(at, ${this.index.size}), ${k})`,
      '  save end, -1',
      '  save nodes, make list',
      '  fork test, run/memo/has(key)',
      '    hold',
      '      save known, run/memo/get(key)',
      '      save end, known/end',
      '      save nodes, known/nodes',
      '    miss',
      '      save base, run/stack/length',
      `      save end, ${body}(run, at)`,
      '      fork test, is-minimum(end, 0)',
      '        hold',
      `          save nodes, ${p}-lift(run, base)`,
      `      save run/memo/{key}, ${p}-step(end, nodes)`,
      '  fork test, is-below(end, 0)',
      '    hold',
      '      back -1',
      ...(this.elide.has(name)
        ? ['  # elided: what it matched stands in the parent in its place', '  walk nodes', '    take one', '    push(run/stack, one)']
        : [`  push(run/stack, ${p}-node(label, at, end, nodes))`]),
      '  back end',
      '',
    )
    this.tasks.push(lines)
    this.sequence(body, this.engine.rules.get(name)!, `\`${name}\`'s body`)
  }

  module(source: string, starts: string[]): string {
    const p = this.p

    for (const name of this.engine.rules.keys()) {
      this.rule(name)
    }

    // the start rule found by name: the usual starts first, then every other rule, each tested once, the run answered
    // from inside the test that found it
    const order = [...starts.filter(name => this.index.has(name)), ...[...this.index.keys()].filter(name => !starts.includes(name))]
    const dispatch: string[] = []

    for (const name of order) {
      dispatch.push(
        `  fork test, is-equal(start, ${textExpression(name, p)})`,
        '    hold',
        `      back ${p}-outcome(run, ${p}-rule-${this.index.get(name)}(run, 0, start))`,
      )
    }

    const head = [
      `# GENERATED by \`pnpm term:grammar-compile --commit\` from ${source}, through the engine the text grammar engine runs.`,
      '# Never edit this file: change the grammar, rebuild the package, and run it again. `--check` fails while the two',
      '# differ. The grammar compiled to Term (task/term/grammar-compile.ts): it reads every text to the outcome',
      '# deck/make/code/compile/mine-text.tree `run-mine` reads it to, the same match tree with the elided rules taken out,',
      '# the same `matched`, and on a failure the same place and the same `expected`.',
      '',
      'load @term/base/list',
      '  find list',
      '  find get',
      '',
      'load @term/base/maybe',
      '  find maybe',
      '',
      'load @term/base/text/unicode',
      '  find to-runes',
      '  find from-runes',
      '',
      '# one rule the text matched, as the interpreter\'s `mine-match`: its name, where it began and ended, and the',
      '# matches under it',
      `form ${p}-match`,
      '  link rule, like text',
      '  link start, like number',
      '  link end, like number',
      `  link children, like list, like ${p}-match`,
      '',
      '# what a run gives, as the interpreter\'s `mine-outcome`: the match of the whole text, or where it got furthest',
      '# and what was wanted there. `matched` is how far the start rule read, -1 when it read nothing',
      `form ${p}-outcome`,
      '  link ok, like boolean',
      `  link match, like maybe, like ${p}-match`,
      '  link at, like number',
      '  link expected, like list, like text',
      '  link matched, like number',
      '',
      '# one rule read at one place: where it ended, -1 when it failed, and the matches it made',
      `form ${p}-step`,
      '  link end, like number',
      `  link nodes, like list, like ${p}-match`,
      '',
      '# one run over one text, as the interpreter\'s `mine-run`: the stack the matches are made on, and the memo keyed',
      '# by number',
      `form ${p}-run`,
      '  mark shared',
      '  link runes, like list, like number',
      '  link size, like number',
      `  link stack, like list, like ${p}-match`,
      `  link memo, like hash, like number, like ${p}-step`,
      '  link furthest, like number',
      '  link expected, like list, like text',
      '  link hoped, like list, like text',
      '  link quiet, like number',
      '',
      `# Run the grammar from the rule \`start\` over the whole of \`input\`, as \`run-mine\` runs it`,
      `task run-${p}-grammar`,
      '  take start, like text',
      '  take input, like text',
      `  like ${p}-outcome`,
      '',
      '  save runes, to-runes(input)',
      '  save run',
      `    make ${p}-run`,
      '      bind runes, runes',
      '      bind size, runes/length',
      '      bind stack, make list',
      '      bind memo, make hash',
      '      bind furthest, 0',
      '      bind expected, make list',
      '      bind hoped, make list',
      '      bind quiet, 0',
      ...dispatch,
      '  # a start the grammar has no rule of: nothing read, as the interpreter reads it',
      `  back ${p}-outcome(run, -1)`,
      '',
      `# the rules whose nodes this compiled grammar does not build: its tree is the interpreter's with these taken out`,
      `task ${p}-grammar-elided`,
      '  like list, like text',
      '',
      '  save out, make list',
      ...[...this.elide].map(name => `  push(out, ${textExpression(name, p)})`),
      '  back out',
      '',
      '# the text a match read',
      `task ${p}-match-text`,
      `  take match, like ${p}-match`,
      '  take source, like text',
      '  like text',
      '',
      '  save runes, to-runes(source)',
      '  back from-runes(runes/slice(match/start, match/end))',
      '',
      '# the matches directly under `match` named `rule`, in order',
      `task ${p}-matches-named`,
      `  take match, like ${p}-match`,
      '  take rule, like text',
      `  like list, like ${p}-match`,
      '',
      '  save out, make list',
      '  walk match/children',
      '    take one',
      '    fork test, is-equal(one/rule, rule)',
      '      hold',
      '        push(out, one)',
      '  back out',
      '',
      '# the first match directly under `match` named `rule`',
      `task ${p}-match-named`,
      `  take match, like ${p}-match`,
      '  take rule, like text',
      `  like maybe, like ${p}-match`,
      '',
      '  walk match/children',
      '    take one',
      '    fork test, is-equal(one/rule, rule)',
      '      hold',
      '        back make(some, one)',
      '  back make none',
      '',
      `task ${p}-outcome`,
      `  take run, like ${p}-run`,
      '  take end, like number',
      `  like ${p}-outcome`,
      '  mark private',
      '',
      '  fork test, and(is-minimum(end, 0), is-equal(end, run/size))',
      '    hold',
      '      save root, get(run/stack, 0)',
      '      back',
      `        make ${p}-outcome`,
      '          bind ok, true',
      '          bind match, make(some, root)',
      '          bind at, run/size',
      '          bind expected, make list',
      '          bind matched, end',
      '  fork test, and(is-minimum(end, 0), is-above(end, run/furthest))',
      '    hold',
      '      save run/furthest, end',
      '      save run/expected, make list',
      '      save run/hoped, make list',
      '  save wanted, run/expected',
      '  fork test, is-equal(wanted/length, 0)',
      '    hold',
      '      save wanted, run/hoped',
      '  back',
      `    make ${p}-outcome`,
      '      bind ok, false',
      '      bind match, make none',
      '      bind at, run/furthest',
      '      bind expected, wanted',
      '      bind matched, end',
      '',
      `task ${p}-rune-at`,
      `  take run, like ${p}-run`,
      '  take at, like number',
      '  like number',
      '  mark private',
      '',
      '  fork test, and(is-minimum(at, 0), is-below(at, run/size))',
      '    hold',
      '      back get(run/runes, at)',
      '  back -1',
      '',
      `task ${p}-step`,
      '  take end, like number',
      `  take nodes, like list, like ${p}-match`,
      `  like ${p}-step`,
      '  mark private',
      '',
      '  back',
      `    make ${p}-step`,
      '      bind end, end',
      '      bind nodes, nodes',
      '',
      `task ${p}-node`,
      '  take label, like text',
      '  take start, like number',
      '  take end, like number',
      `  take children, like list, like ${p}-match`,
      `  like ${p}-match`,
      '  mark private',
      '',
      '  back',
      `    make ${p}-match`,
      '      bind rule, label',
      '      bind start, start',
      '      bind end, end',
      '      bind children, children',
      '',
      '# the stack cut back to how high it stood before a try that failed',
      `task ${p}-cut`,
      `  take run, like ${p}-run`,
      '  take mark, like number',
      '  mark private',
      '',
      '  walk test',
      '    hook test, is-above(run/stack/length, mark)',
      '    hook hold',
      '      run/stack/pop()',
      '',
      '# what was pushed since `base`, taken off the stack',
      `task ${p}-lift`,
      `  take run, like ${p}-run`,
      '  take base, like number',
      `  like list, like ${p}-match`,
      '  mark private',
      '',
      '  save stack, run/stack',
      '  save nodes, stack/slice(base, stack/length)',
      `  ${p}-cut(run, base)`,
      '  back nodes',
      '',
      '# the text of code points no literal should spell',
      `task ${p}-text-of`,
      '  take codes, like list, like number',
      '  like text',
      '  mark private',
      '',
      '  back from-runes(codes)',
      '',
      '# the interpreter\'s `expect`: what would have let the run go on, kept for the furthest place reached only, and',
      '# as hoped rather than expected inside a `list` or a `maybe`, which may fail',
      `task ${p}-expect`,
      `  take run, like ${p}-run`,
      '  take at, like number',
      '  take wanted, like text',
      '  mark private',
      '',
      '  fork test, is-below(at, run/furthest)',
      '    hold',
      '      back',
      '  fork test, is-above(at, run/furthest)',
      '    hold',
      '      save run/furthest, at',
      '      save run/expected, make list',
      '      save run/hoped, make list',
      '  fork test, is-above(run/quiet, 0)',
      '    hold',
      `      fork test, not(${p}-has-text(run/hoped, wanted))`,
      '        hold',
      '          push(run/hoped, wanted)',
      '      back',
      `  fork test, not(${p}-has-text(run/expected, wanted))`,
      '    hold',
      '      push(run/expected, wanted)',
      '',
      `task ${p}-expect-char`,
      `  take run, like ${p}-run`,
      '  take at, like number',
      '  take code, like number',
      '  mark private',
      '',
      '  save codes, make list',
      '  push(codes, code)',
      `  ${p}-expect(run, at, <\`{from-runes(codes)}\`>)`,
      '',
      `task ${p}-has-text`,
      '  take values, like list, like text',
      '  take wanted, like text',
      '  like boolean',
      '  mark private',
      '',
      '  walk values',
      '    take one',
      '    fork test, is-equal(one, wanted)',
      '      hold',
      '        back true',
      '  back false',
      '',
    ]

    return [...head, ...this.tasks.flat()].join('\n')
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  const commit = process.argv.includes('--commit')

  for (const grammar of GRAMMARS) {
    const built = join(MILL, grammar.engine)

    if (!existsSync(built)) {
      console.error(`the engine is not built: run term make --trees in ${MILL}`)
      process.exit(1)
    }

    const module = await import(pathToFileURL(built).href)
    const engine = module[grammar.make]() as Engine

    if (engine.refused.length > 0) {
      console.error(`the engine refuses the grammar: ${engine.refused.join('; ')}`)
      process.exit(1)
    }

    const compiler = new Compiler(grammar.prefix, engine, grammar.elide)

    compiler.checkStarts(grammar.starts)

    const compiled = compiler.module(grammar.source, grammar.starts)
    const out = join(MILL, grammar.out)
    const have = existsSync(out) ? readFileSync(out, 'utf8') : undefined
    const relative = out.slice(ROOT.length + 1)

    console.log(`${grammar.prefix}: ${engine.rules.size} rules`)

    if (have === compiled) {
      console.log(`  unchanged ${relative}`)
    } else if (check) {
      console.log(`  STALE ${relative}: run pnpm term:grammar-compile --commit`)
      process.exitCode = 1
    } else if (commit) {
      writeFileSync(out, compiled)
      console.log(`  wrote ${relative} (${compiled.split('\n').length} lines)`)
    } else {
      console.log(`  would write ${relative}: pass --commit`)
    }
  }
}

main()
