// THE LATEX READER HELD TO KATEX: every formula KaTeX's own tests parse, read by both parsers, in inline and display
// mode, and the two trees compared, or the two refusals. KaTeX is the reader's unbiased witness: the reader's own tests
// were written by the person who wrote the reader, and agree with it by construction. note/term/mill/04-latex-grammar.md.
//
// The corpus is every string in KaTeX's test/katex-spec.ts, test/errors-spec.ts and test/unicode-spec.ts (a tagged
// `expect` or `r` literal read raw, as KaTeX's tests read it) and every formula of test/screenshotter/ss_data.yaml, with
// its macros. Many of those strings are test names rather than math, and they stay: both parsers must agree on them too.
//
// A tree is compared as JSON with KaTeX's `loc` and `token` left out (they count UTF-16 units and hold lexer objects)
// and every null or undefined field dropped, keys sorted. A refusal is compared by KaTeX's raw message.
//
//   pnpm term:latex-katex                       the counts, and the first disagreements of each kind
//   pnpm term:latex-katex --all                 every disagreement
//   pnpm term:latex-katex --only '\frac'        the cases whose source holds the text
//   pnpm term:latex-katex --strict              exit 1 on any disagreement
//   pnpm term:latex-katex --fuzz N --seed S     N mutated sources from another start of the sequence
//   --katex <dir>                               a KaTeX checkout (default: land/code/github.com/KaTeX/KaTeX beside this repo)
//
// The reader is the one `term make --trees` builds in deck/mill, from its host/ output.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import yaml from 'js-yaml'
import { TERM_ROOT, parentRoot } from './root'

const ROOT = TERM_ROOT
const MILL = join(TERM_ROOT, 'deck/mill')

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name)

  return at < 0 ? undefined : process.argv[at + 1]
}

const KATEX = resolve(option('--katex') ?? join(parentRoot(), '../../land/code/github.com/KaTeX/KaTeX'))
const ALL = process.argv.includes('--all')
const STRICT = process.argv.includes('--strict')
const ONLY = option('--only')

type Case = { source: string; macros: Record<string, string>; from: string }

// ---- the corpus ----

function specStrings(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []

  function visit(node: ts.Node): void {
    if (ts.isTaggedTemplateExpression(node) && ts.isNoSubstitutionTemplateLiteral(node.template)) {
      const tag = node.tag.getText(tree)

      if (tag === 'expect' || tag === 'r') {
        out.push(node.template.rawText ?? node.template.text)

        return
      }
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text)
    }

    ts.forEachChild(node, visit)
  }

  visit(tree)

  return out
}

function corpus(): Case[] {
  const cases: Case[] = []
  const seen = new Set<string>()

  function add(source: string, macros: Record<string, string>, from: string): void {
    const key = `${source}\u0000${JSON.stringify(macros)}`

    if (seen.has(key)) {
      return
    }

    seen.add(key)
    cases.push({ source, macros, from })
  }

  for (const spec of ['katex-spec.ts', 'errors-spec.ts', 'unicode-spec.ts']) {
    const file = join(KATEX, 'test', spec)

    if (existsSync(file)) {
      for (const one of specStrings(file)) {
        add(one, {}, spec)
      }
    }
  }

  // the documentation's examples: every math span and every code span, which between them name nearly every command
  // KaTeX supports. Corpus harvesting, so a span the patterns cut wrongly is one more input both parsers must agree on
  const docs = join(KATEX, 'docs')

  for (const name of ['supported.md', 'support_table.md', 'options.md', 'issues.md', 'migration.md']) {
    const file = join(docs, name)

    if (!existsSync(file)) {
      continue
    }

    const text = readFileSync(file, 'utf8')

    for (const found of text.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|`([^`\n]+)`|<code>([^<]+)<\/code>/g)) {
      const span = (found[1] ?? found[2] ?? found[3] ?? found[4])
        .replace(/&#124;/g, '|')
        .replace(/&#92;/g, '\\')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\\\\/g, found[4] !== undefined ? '\\' : '\\\\')

      add(span, {}, `docs/${name}`)
    }
  }

  const screenshots = yaml.load(readFileSync(join(KATEX, 'test/screenshotter/ss_data.yaml'), 'utf8')) as Record<string, unknown>

  for (const [name, value] of Object.entries(screenshots)) {
    if (typeof value === 'string') {
      add(value, {}, `ss_data ${name}`)
    } else if (value && typeof value === 'object' && typeof (value as { tex?: unknown }).tex === 'string') {
      const item = value as { tex: string; macros?: Record<string, string> }

      add(item.tex, item.macros ?? {}, `ss_data ${name}`)
    }
  }

  // the edges no corpus case reaches: delimiters and characters past ASCII and past U+FFFF, and every strict-mode code,
  // in a source and in a macro body
  for (const [source, macros] of PROBES) {
    add(source, macros, 'probe')
  }

  return ONLY ? cases.filter(one => one.source.includes(ONLY)) : cases
}

const PROBES: [string, Record<string, string>][] = [
  ['\\verb§x§', {}],
  ['\\verb*§x y§', {}],
  ['\\verbéaé', {}],
  ['\\verb𝑥a𝑥', {}],
  ['\\verb日本日', {}],
  ['\\verb§x', {}],
  ['\\verb§x§y§ z', {}],
  ['\\verb\tx\t', {}],
  ['\\verb\nx\n', {}],
  ['\\verb\tx', {}],
  ['\\verb*\u00a0a b\u00a0', {}],
  ['\\text{\\verb§x§}', {}],
  ['\\verb§x§ %', {}],
  ['\\verb§x§\u0001', {}],
  ['\\url{a𝑥b}', {}],
  ['\\href{http://a.b/𝑥}{y}', {}],
  ['\\url{é}', {}],
  ['𝑥', {}],
  ['\\text{𝑥}', {}],
  ['a\u0301', {}],
  ['\\text{a\u0301}', {}],
  ['\u00a0', {}],
  ['Ð Þ þ', {}],
  ['\\text{Ð}', {}],
  ['Ж', {}],
  ['\\text{日本}', {}],
  ['日本', {}],
  ['\u2028', {}],
  ['\\kern1mu \\mkern1em \\mskip2em \\hskip3mu', {}],
  ['\\text{\\mkern1mu}', {}],
  ['\\begin{array}{c}a&b\\end{array}', {}],
  ['\\begin{array}{cc}a&b&c\\\\d\\end{array}', {}],
  ['a \\\\ b', {}],
  ['a \\newline b', {}],
  ['x %', {}],
  ['x %\n', {}],
  ['\\def\\a{x%}\\a\\a', {}],
  ['\\R + \\R', { '\\R': 'x%' }],
  ["\\'a \\sout{x} \\text{\\sout{x}} \\htmlClass{a}{b}", {}],
  ['é \\text{é}', {}],
  ['\\begin{CD}@&\\end{CD}', {}],
  ['\\begin{CD}A @<a<< B\\\\@ & x\\end{CD}', {}],
  ['\\def\\sqr#1{#2} \\sqr{x}', {}],
  ['\\def\\a#1#2{#3#1} \\a xy', {}],
  ['\\def\\a{#2} \\a', {}],
]

// ---- mutations ----
//
// `--fuzz N` adds N sources made from the corpus: a splice of two sources at random code points, a span cut out, or a
// piece inserted, from the characters TeX gives meaning to or the commands both tables hold. The generator is a fixed
// linear congruential sequence, so a run is the same run every time and a disagreement it finds can be found again.

function mutations(cases: Case[], count: number, commands: string[], seed: number): Case[] {
  let state = seed >>> 0

  function next(limit: number): number {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0

    return limit <= 0 ? 0 : state % limit
  }

  const pieces = ['{', '}', '^', '_', '&', '\\\\', '[', ']', '(', ')', '$', '%', '~', '#', "'", ' ', '\n', '\\', '@', '|', '=', '1', 'x',
    'é', 'Ж', '日', '𝑥', 'Ð', '́', ' ', '§', ...commands]
  const out: Case[] = []

  // one mutation of a source: a splice with another source at random code points, a span cut out, or a piece inserted
  function mutate(a: string[]): string[] {
    switch (next(3)) {
      case 0: {
        const b = [...cases[next(cases.length)].source]

        return [...a.slice(0, next(a.length + 1)), ...b.slice(next(b.length + 1))]
      }
      case 1: {
        const from = next(a.length + 1)

        return [...a.slice(0, from), ...a.slice(from + 1 + next(4))]
      }
      default: {
        const at = next(a.length + 1)

        return [...a.slice(0, at), ...pieces[next(pieces.length)], ...a.slice(at)]
      }
    }
  }

  // one to three mutations stacked, so a source reaches what no single edit of the corpus does
  for (let i = 0; i < count; i++) {
    let made = [...cases[next(cases.length)].source]
    const steps = 1 + next(3)

    for (let step = 0; step < steps; step++) {
      made = mutate(made)
    }

    out.push({ source: made.join(''), macros: {}, from: `mutation ${i}` })
  }

  return out
}

// ---- the two parsers ----

// a strict-mode warning: KaTeX's code and message, and where it stands. `at` and `end` are code points in the source,
// `placed` whether a place was named at all (KaTeX names a token, which may stand in a macro's body rather than the
// source, and then `at` is undefined though `placed` is true)
type Warning = { code: string; message: string; placed: boolean; at: number | undefined; end: number | undefined }

// `crashed` is a refusal that was no refusal: KaTeX threw a JavaScript runtime error (a TypeError reading a field of
// nothing), a defect of KaTeX's, where the reader must refuse but no message is KaTeX's to match
type Outcome = ({ ok: true; tree: string } | { ok: false; message: string; at: number | undefined; crashed?: boolean }) & { warnings: Warning[] }

// two warning lists the same: every code and message, a place where KaTeX names one, and that place where it is in the
// source
function sameWarnings(theirs: Warning[], mine: Warning[]): boolean {
  return theirs.length === mine.length && theirs.every((one, k) => {
    const other = mine[k]

    return one.code === other.code && one.message === other.message && one.placed === other.placed &&
      (one.at === undefined || (one.at === other.at && one.end === other.end))
  })
}

// Whether KaTeX's answer holds half a character: a UTF-16 surrogate with no partner, raw or as a JSON escape. KaTeX
// reads `\verb` delimiters and `\url` characters a UTF-16 unit at a time, so a character past U+FFFF comes apart in
// two. The reader reads a character whole, which is the only reading a native backend's text can hold, so where KaTeX
// splits one the two disagree by design, and are counted apart
function splitsCharacter(answer: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(answer)
}

function showWarnings(warnings: Warning[]): string {
  return warnings.map(one => `${one.code}${one.placed ? `@${one.at ?? '?'}-${one.end ?? '?'}` : ''} ${JSON.stringify(one.message)}`).join(', ') || 'none'
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}

    for (const key of Object.keys(value).sort()) {
      const field = (value as Record<string, unknown>)[key]

      if (key === 'loc' || key === 'token' || field === null || field === undefined) {
        continue
      }

      out[key] = canonical(field)
    }

    return out
  }

  return value
}

// a UTF-16 offset as a code point offset, which is how the reader counts
function codePointsBefore(source: string, units: number): number {
  return [...source.slice(0, units)].length
}

// Whether KaTeX's offset is in the source at all. A token a macro made is placed in the macro's BODY, which KaTeX lexes
// as an input of its own, so its offset counts in another text; the reader places it at the command that was
// expanded. KaTeX's message quotes the input around the offset (src/ParseError.ts), so building that quote from the
// source says which input it was
function inSource(source: string, raw: string, message: string, start: number, end: number): boolean {
  let error = `KaTeX parse error: ${raw}`

  error += start === source.length ? ' at end of input: ' : ` at position ${start + 1}: `

  const underlined = source.slice(start, end).replace(/[^]/g, '$&̲')
  const left = start > 15 ? `…${source.slice(start - 15, start)}` : source.slice(0, start)
  const right = end + 15 < source.length ? `${source.slice(end, end + 15)}…` : source.slice(end)

  return message === error + left + underlined + right
}

async function main(): Promise<void> {
  for (const file of ['src/parseTree.ts', 'src/Settings.ts']) {
    if (!existsSync(join(KATEX, file))) {
      console.error(`no KaTeX checkout at ${KATEX}: clone it with git clone --depth 1 https://github.com/KaTeX/KaTeX`)
      process.exit(1)
    }
  }

  const built = join(MILL, 'host/code/text/latex')

  for (const file of ['read.ts', 'lex.ts', 'json.ts', 'engine.ts', 'compiled.ts']) {
    if (!existsSync(join(built, file))) {
      console.error(`the reader is not built: run term make --trees in ${MILL}`)
      process.exit(1)
    }
  }

  const parseTree = (await import(pathToFileURL(join(KATEX, 'src/parseTree.ts')).href)).default
  const Settings = (await import(pathToFileURL(join(KATEX, 'src/Settings.ts')).href)).default
  const reader = await import(pathToFileURL(join(built, 'read.ts')).href)
  const lexer = await import(pathToFileURL(join(built, 'lex.ts')).href)
  const json = await import(pathToFileURL(join(built, 'json.ts')).href)

  const tableStarted = performance.now()
  const table = lexer.makeLatexTable()
  const tableMs = performance.now() - tableStarted

  // `strict` is `warn`, read as KaTeX's default reads (a warning answered `ignore`, so the tree is the one it builds),
  // with every warning kept, or `error`
  function katex(source: string, display: boolean, macros: Record<string, string>, strict: 'warn' | 'error'): Outcome {
    const warnings: Warning[] = []
    const collect = (code: string, message: string, token?: { loc?: { lexer: { input: string }; start: number; end: number } }) => {
      const loc = token?.loc
      const here = loc !== undefined && loc.lexer.input === source

      warnings.push({
        code,
        message,
        placed: token !== undefined,
        at: here ? codePointsBefore(source, loc.start) : undefined,
        end: here ? codePointsBefore(source, loc.end) : undefined,
      })

      return 'ignore'
    }

    // KaTeX writes `\message` and `\errmessage` to the console, which the reader reads and drops
    const log = console.log
    const logError = console.error

    console.log = () => {}
    console.error = () => {}

    try {
      const settings = new Settings({ displayMode: display, trust: true, strict: strict === 'warn' ? collect : 'error', macros: { ...macros } })
      const tree = parseTree(source, settings)

      return { ok: true, tree: JSON.stringify(canonical(JSON.parse(JSON.stringify(tree, (key, value) => (key === 'loc' || key === 'token' ? undefined : value))))), warnings }
    } catch (error) {
      const e = error as { rawMessage?: string; position?: number; length?: number; message: string; name?: string }
      const raw = e.rawMessage ?? e.message
      const placed = e.position !== undefined && inSource(source, raw, e.message, e.position, e.position + (e.length ?? 0))
      const crashed = error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError

      return { ok: false, message: raw, at: placed ? codePointsBefore(source, e.position!) : undefined, crashed, warnings }
    } finally {
      console.log = log
      console.error = logError
    }
  }

  function ours(source: string, display: boolean, macros: Record<string, string>, strict: 'warn' | 'error'): Outcome {
    const options = reader.latexDefaults()

    options.display = display
    options.macros = Object.entries(macros).map(([name, expansion]) => ({ name, expansion }))
    options.strict = strict

    const read = reader.readLatex(source, table, options)
    const warnings: Warning[] = read.warnings.map((one: { code: string; message: string; place: { form: string; value?: { at: number; end: number } } }) => ({
      code: one.code,
      message: one.message,
      placed: one.place.form === 'some',
      at: one.place.value?.at,
      end: one.place.value?.end,
    }))

    if (read.nodes.form === 'some') {
      return { ok: true, tree: JSON.stringify(canonical(JSON.parse(json.writeLatexJson(read.nodes.value)))), warnings }
    }

    const problem = read.problem.form === 'some' ? read.problem.value : { message: 'no problem given', at: 0 }

    return { ok: false, message: problem.message, at: problem.at, warnings }
  }

  const cases = corpus()
  const fuzz = Number(option('--fuzz') ?? 0)

  if (fuzz > 0) {
    const commands = [...table.functions.keys(), ...table.macros.keys()].filter((name: string) => name.startsWith('\\'))

    for (const one of mutations(cases, fuzz, commands, Number(option('--seed') ?? 0x2545f491))) {
      cases.push(one)
    }
  }

  const kinds: Record<string, string[]> = {
    'same tree': [],
    'same refusal': [],
    'same refusal placed otherwise': [],
    'refusal worded otherwise': [],
    'KaTeX reads it, the reader refuses': [],
    'the reader reads it, KaTeX refuses': [],
    'trees differ': [],
    'warnings differ': [],
    'KaTeX splits a character past U+FFFF': [],
    'KaTeX crashes, the reader refuses': [],
    'KaTeX crashes, the reader does not refuse': [],
  }
  let katexMs = 0
  let oursMs = 0
  let crashed = 0
  let readings = 0
  let warned = 0

  for (const one of cases) {
    for (const display of [false, true]) {
      for (const strict of ['warn', 'error'] as const) {
      const label = `${JSON.stringify(one.source)}${display ? ' (display)' : ''}${strict === 'error' ? ' (strict error)' : ''} [${one.from}]`
      const startedKatex = performance.now()
      const theirs = katex(one.source, display, one.macros, strict)

      katexMs += performance.now() - startedKatex

      let mine: Outcome
      const startedOurs = performance.now()

      try {
        mine = ours(one.source, display, one.macros, strict)
      } catch (error) {
        crashed++
        mine = { ok: false, message: `CRASH ${(error as Error).message}`, at: undefined, warnings: [] }
      }

      oursMs += performance.now() - startedOurs
      readings++

      if (strict === 'warn') {
        if (!sameWarnings(theirs.warnings, mine.warnings)) {
          kinds['warnings differ'].push(`${label}\n      katex  ${showWarnings(theirs.warnings)}\n      reader ${showWarnings(mine.warnings)}`)
        }
      }

      const agreed = theirs.ok && mine.ok
        ? theirs.tree === mine.tree
        : !theirs.ok && !mine.ok && theirs.message === mine.message && (theirs.at === undefined || theirs.at === mine.at)

      // `the reader failed:` is the reader's own defect surfacing, never a refusal it meant
      const readerFailed = !mine.ok && mine.message.startsWith('the reader failed')

      if (!theirs.ok && theirs.crashed) {
        kinds[mine.ok || readerFailed ? 'KaTeX crashes, the reader does not refuse' : 'KaTeX crashes, the reader refuses'].push(`${label}\n      katex  ${theirs.message}\n      reader ${mine.ok ? mine.tree : `at ${mine.at}: ${mine.message}`}`)
      } else if (!agreed && splitsCharacter(theirs.ok ? theirs.tree : theirs.message)) {
        kinds['KaTeX splits a character past U+FFFF'].push(`${label}\n      katex  ${theirs.ok ? theirs.tree : `at ${theirs.at}: ${theirs.message}`}\n      reader ${mine.ok ? mine.tree : `at ${mine.at}: ${mine.message}`}`)
      } else if (theirs.ok && mine.ok) {
        if (theirs.tree === mine.tree) {
          kinds['same tree'].push(label)
        } else {
          kinds['trees differ'].push(`${label}\n      katex  ${theirs.tree}\n      reader ${mine.tree}`)
        }
      } else if (!theirs.ok && !mine.ok) {
        if (theirs.message === mine.message && (theirs.at === undefined || theirs.at === mine.at)) {
          kinds['same refusal'].push(label)
        } else if (theirs.message === mine.message) {
          kinds['same refusal placed otherwise'].push(`${label}\n      katex  at ${theirs.at}, reader at ${mine.at}: ${mine.message}`)
        } else {
          kinds['refusal worded otherwise'].push(`${label}\n      katex  at ${theirs.at}: ${theirs.message}\n      reader at ${mine.at}: ${mine.message}`)
        }
      } else if (theirs.ok && !mine.ok) {
        kinds['KaTeX reads it, the reader refuses'].push(`${label}\n      reader at ${mine.at}: ${mine.message}`)
      } else if (!theirs.ok) {
        kinds['the reader reads it, KaTeX refuses'].push(`${label}\n      katex  at ${theirs.at}: ${theirs.message}`)
      }

      // with no warning on either side, `error` reads exactly as `warn` does, so it is read only where one was given
      if (strict === 'warn') {
        if (theirs.warnings.length === 0 && mine.warnings.length === 0) {
          break
        }

        warned++
      }
      }
    }
  }

  // ---- the compiled grammar against the interpreter ----
  //
  // Every source run from every start rule the reader runs, by the text grammar engine and by the compiled grammar,
  // the whole outcome compared: the match tree, where it ended, and on a failure the place and what was expected.
  // Most sources are no size and no color, so most of these runs fail, which holds the failure bookkeeping as hard as
  // the matches

  const engineModule = await import(pathToFileURL(join(built, 'engine.ts')).href)
  const compiledModule = await import(pathToFileURL(join(built, 'compiled.ts')).href)
  const mineText = await import(pathToFileURL(join(MILL, 'host/.unit/_term_make_code_compile_mine-text.ts')).href)
  const engine = engineModule.latexEngine()

  // the interpreter's tree with the rules the compiled grammar does not build taken out, their matches spliced into
  // the parent where they stood: the tree the compiled grammar promises
  const elided = new Set<string>(compiledModule.latexGrammarElided())

  function project(match: { rule: string; start: number; end: number; children: unknown[] }): unknown[] {
    const children = (match.children as (typeof match)[]).flatMap(project)

    return elided.has(match.rule) ? children : [{ ...match, children }]
  }

  function projected(outcome: { match: { form: string; value?: Parameters<typeof project>[0] } }): unknown {
    if (outcome.match.form !== 'some') {
      return outcome
    }

    return { ...outcome, match: { form: 'some', value: project(outcome.match.value!)[0] } }
  }

  const starts = [
    'tokens', 'url-tokens', 'size-text', 'size-search', 'graphic-number', 'color-text', 'whole-number', 'column-count',
    'integer-text', 'float-text', 'url-text', 'url-protocol', 'url-scheme-name', 'data-attributes', 'graphic-attributes',
    'verb-command',
  ]
  let grammarRuns = 0
  let grammarSame = 0
  let interpretedMs = 0
  let compiledMs = 0
  const grammarDiffer: string[] = []

  for (const one of cases) {
    for (const start of starts) {
      const startedInterpreted = performance.now()
      const interpreted = JSON.stringify(projected(mineText.runMine(engine, start, one.source)))

      interpretedMs += performance.now() - startedInterpreted

      const startedCompiled = performance.now()
      const compiled = JSON.stringify(compiledModule.runLatexGrammar(start, one.source))

      compiledMs += performance.now() - startedCompiled
      grammarRuns++

      if (interpreted === compiled) {
        grammarSame++
      } else {
        grammarDiffer.push(`${start} ${JSON.stringify(one.source)}\n      interpreted ${interpreted.slice(0, 300)}\n      compiled    ${compiled.slice(0, 300)}`)
      }
    }
  }

  console.log(`the compiled grammar: ${grammarSame} of ${grammarRuns} runs read to the interpreter's outcome, in ${compiledMs.toFixed(0)} ms against ${interpretedMs.toFixed(0)} ms`)

  for (const line of ALL ? grammarDiffer : grammarDiffer.slice(0, 8)) {
    console.log(`    ${line}`)
  }

  // the two kinds where KaTeX's answer is not one to agree with: a character split in two, and a crash the reader
  // refuses. A crash the reader READS is a disagreement like any other
  const split = kinds['KaTeX splits a character past U+FFFF'].length
  const crashes = kinds['KaTeX crashes, the reader refuses'].length
  const total = readings - split - crashes
  const agree = kinds['same tree'].length + kinds['same refusal'].length
  const warnedSame = warned - kinds['warnings differ'].length

  console.log(`${cases.length} sources, ${readings} readings: inline and display, and again with strict set to error for the ${warned} that warned`)
  console.log(`  ${agree} of ${total} agree: ${kinds['same tree'].length} the same tree, ${kinds['same refusal'].length} the same refusal. Apart, listed below: ${split} where KaTeX splits a character past U+FFFF, ${crashes} where KaTeX crashes and the reader refuses`)
  console.log(`  ${cases.length * 2 - kinds['warnings differ'].length} of ${cases.length * 2} give KaTeX's warnings, ${warnedSame} of them one or more`)

  for (const [kind, labels] of Object.entries(kinds)) {
    if (kind === 'same tree' || kind === 'same refusal') {
      continue
    }

    console.log(`  ${labels.length} ${kind}`)

    for (const label of ALL ? labels : labels.slice(0, 8)) {
      console.log(`    ${label}`)
    }
  }

  if (crashed > 0) {
    console.log(`  ${crashed} readings crashed the reader`)
  }

  console.log(`time: KaTeX ${katexMs.toFixed(0)} ms, the reader ${oursMs.toFixed(0)} ms over ${total} readings, its tables made once in ${tableMs.toFixed(0)} ms`)

  if (STRICT && (agree !== total || kinds['warnings differ'].length > 0 || grammarSame !== grammarRuns)) {
    process.exitCode = 1
  }
}

main()
