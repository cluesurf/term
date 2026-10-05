// The diagnostic system. Self-contained, fast, and readable. Every phase of the compiler reports through this.
// See the plan at note/research/vibe/computation/plans/02-diagnostics.md.

import chalk from 'chalk'

// A position in the source: zero-based line and column.
export type Position = { line: number; column: number }

// A range from a start to an end position.
// `file` is the module the span is IN, and it is optional because most spans never leave the file being read.
//
// It matters once modules MERGE. `compileProgram` receives one flat program built from every reachable unit, so a
// span alone would blame the entry file for an error living three imports away. This used to be carried beside the
// program in a `WeakMap<Statement, string>` threaded through nine files, which Term cannot express: the language
// has no weak reference, and an identity-keyed map is not a construct it has either (self-hosting-0002).
//
// Putting it on the span is smaller than the map it replaces AND more correct: `structuredClone` copies it, so the
// dictionary-pass clone keeps every statement's origin for free, where the map needed an index-paired fixup loop
// that would silently misattribute a whole module if the clone ever reordered.
export type Span = { start: Position; end: Position; file?: string }

export type Severity = 'error' | 'warning' | 'info'

// One labeled range inside a diagnostic. A diagnostic can point at several places at once.
export type Marker = { span: Span; label?: string }

export type Diagnostic = {
  code: number
  // a lint finding's own rule code, `L023`, printed in place of `code`. Lint codes are decimal and the compiler's
  // are hexadecimal, so printing a lint code as a compiler code showed L023 as `0017` (guides: commands/lint)
  rule?: string
  name: string
  message: string
  file: string
  span: Span
  markers: Marker[]
  hint?: string
  severity: Severity
}

type CatalogEntry = {
  code: number
  message: string
  severity: Severity
  fix: string
}

// The catalog of diagnostic codes. Codes are permanent. `fix` is the default actionable hint, so every error
// tells you how to resolve it.
export const CATALOG = {
  'syntax-error': {
    code: 0x1,
    message: 'error in the structure of the tree',
    severity: 'error',
    fix: 'check the brackets, the two-space indentation, and the commas on this line',
  },
  'invalid-nesting': {
    code: 0x2,
    message: 'the tree has invalid nesting',
    severity: 'error',
    fix: 'a number is a value: it cannot have children or be the head of a line',
  },
  'invalid-indentation': {
    code: 0x3,
    message: 'the tree has invalid indentation',
    severity: 'error',
    fix: 'indent exactly one level (two spaces) deeper than the parent line',
  },
  'not-implemented': {
    code: 0x4,
    message: 'this feature is not implemented yet',
    severity: 'error',
    fix: 'this construct is recognized but not yet compiled',
  },
  'unknown-name': {
    code: 0x5,
    message: 'this name is not defined',
    severity: 'error',
    fix: 'define it, import it, or check the spelling',
  },
  'unexpected-node': {
    code: 0x6,
    message: 'this node is not valid here',
    severity: 'error',
    fix: 'this term is not allowed in this position',
  },
  'type-mismatch': {
    code: 0x7,
    message: 'the types do not match',
    severity: 'error',
    fix: 'make the value match the expected type, or adjust the annotation',
  },
  unproven: {
    code: 0x8,
    message: 'this hold could not be proven',
    severity: 'error',
    fix: 'add the assumption it needs (e.g. a natural-number bound), or weaken the claim',
  },
  'incomplete-instance': {
    code: 0x9,
    message: 'this trait implementation is missing methods',
    severity: 'error',
    fix: 'implement every method the trait declares',
  },
  // a `like <name>` naming no form, enum, primitive, generic, mask, alias or opaque native type: it used to compile
  // clean and emit a type the target language has never heard of
  'unknown-type': {
    code: 0x14,
    message: 'this type name is not defined',
    severity: 'warning',
    fix: 'declare the form, import it, or check the spelling',
  },
  'unused-binding': {
    code: 0xa,
    message: 'this binding is never used',
    severity: 'warning',
    fix: 'remove it, or use it',
  },
  'non-exhaustive': {
    code: 0xb,
    message: 'this match does not cover every case',
    severity: 'error',
    fix: 'add the missing cases, or one `hook miss` arm for every case not listed',
  },
  'no-instance': {
    code: 0xc,
    message: 'no trait instance for this type',
    severity: 'error',
    fix: 'implement the trait for this type with `wear` or `suit`',
  },
  'non-positive': {
    code: 0xd,
    message:
      'this type occurs in a non-positive position in its own definition',
    severity: 'error',
    fix: 'a type cannot appear to the left of an arrow within its own fields; restructure the definition',
  },
  'non-terminating': {
    code: 0xe,
    message: 'this recursion could not be shown to terminate',
    severity: 'warning',
    fix: 'make a recursive call decrease an argument (e.g. a structurally smaller value), or add a base case',
  },
  // NOT PROVEN IS NOT PROVEN. This was a warning until 2026-09-18, which meant a claim the prover could not
  // reach compiled green: `a * b == a * a` over two naturals, and `secret a == a` where `secret` adds one, both
  // passed with nothing but a warning (tmp probe, law-proof-gate-0002). A claim nobody checked and a claim
  // somebody checked are not the same thing, and a gate that cannot tell them apart is not a gate. The stdlib
  // emitted zero of these across 534 files, so the change costs nothing and closes the hole.
  'unchecked-hold': {
    code: 0xf,
    message:
      'this hold is outside the decidable linear fragment: it was neither proven nor refuted, and may still be true',
    severity: 'error',
    // `mark open` is accepted only on a claim, a `rule` with no `show`, so the hint says so: offered bare, it sent a
    // reader to mark a theorem, which refuses it (guides: tests/laws, 2026-10-04). `unproven` is the other verdict,
    // a goal the provers can decide and that does not follow
    fix: 'rewrite it as a linear comparison (<, <=, >, >=, ==), prove it in the dependent kernel with `calm` / `fold` / `cite`, or state it as a claim (a `rule` with no `show`) and `mark open` that, to leave it open and counted',
  },
  'duplicate-instance': {
    code: 0x10,
    message:
      'this trait is implemented more than once for the same type',
    severity: 'error',
    fix: 'remove the overlapping implementation; a type may implement a trait only once (coherence)',
  },
  'duplicate-definition': {
    code: 0x13,
    message: 'this name is defined more than once',
    severity: 'error',
    fix: 'rename one of the definitions; a top-level task or form name must be unique within the program',
  },
  'effect-error': {
    code: 0x11,
    message: 'an effect is used inconsistently',
    severity: 'error',
    fix: 'mark the task async, await the asynchronous call, or only await asynchronous tasks',
  },
  'invalid-proof': {
    code: 0x12,
    message: 'this proof does not establish the proposition',
    severity: 'error',
    fix: 'check the tactic and its argument; `melt` needs both sides to compute equal, `cite` needs a proven lemma of the same statement',
  },
  // A `rule` states a claim. A `task` of the same name fills it. Between the two the name is DECLARED and not
  // DEFINED, and nothing may use it as though it were proven. An unfilled claim used to compile silently, which
  // made a rule a comment with a type on it.
  'open-claim': {
    code: 0x15,
    message: 'this claim has no proof',
    severity: 'error',
    fix: 'write a `task` of the same name whose body proves it, or mark the rule `mark open` to leave it open and counted',
  },
  // Using a claim that nobody has proven yet. The claim is a promise, and code that runs cannot be built on one.
  'open-claim-used': {
    code: 0x16,
    message: 'this name is an open claim, not a proven one',
    severity: 'error',
    fix: 'prove it with a `task` of the same name, or stop calling it',
  },
  // A proof is a task, and a task the kernel never checked proves nothing. Until 2026-10-02 a claim was filled by
  // ANY task of its name: one that recursed forever proved `any x equals any y` with a warning (proof-by-default-0003),
  // and one whose type did not resolve proved a gradual nothing. A fill must be verified by the kernel, terminate,
  // and touch nothing outside itself, or it is not a proof.
  'unverified-proof': {
    code: 0x17,
    message: 'this proof was not verified by the kernel',
    severity: 'error',
    fix: 'state the claim at types the kernel can read (load the forms it names), and write the proof in the pure fragment: no loops, no mutation, no native calls',
  },
  'looping-proof': {
    code: 0x18,
    message: 'this proof is not shown to terminate',
    severity: 'error',
    fix: 'a proof that never ends proves anything, so recurse only on a structurally smaller argument',
  },
  'impure-proof': {
    code: 0x19,
    message: 'this proof calls something impure',
    severity: 'error',
    fix: 'a proof may call only pure tasks: no native calls, no async, no writes through a record it did not make',
  },
  // A `twin` is another implementation of a task, which the compiler may choose in its place, so it must be able to
  // agree with it (note/term/optimize/admission.md). Each of these is a twin that could not.
  'twin-unknown': {
    code: 0x1a,
    message: 'this twin names no task',
    severity: 'error',
    fix: 'a twin is written `twin <task>, name <label>` beside a task this module can see',
  },
  'twin-of-impure': {
    code: 0x1b,
    message: 'this twin is of a task that is not pure',
    severity: 'error',
    fix: 'only a pure task can be computed another way: one that reaches native code, is async, or writes what it did not make has an order of effects a twin would have to repeat',
  },
  'twin-impure': {
    code: 0x1c,
    message: 'this twin is not pure',
    severity: 'error',
    fix: 'a twin of a pure task must be pure itself, or say `mark trust` to be admitted as trusted',
  },
  'twin-signature': {
    code: 0x1d,
    message: "this twin's parameters are not its task's",
    severity: 'error',
    fix: "name the task's parameters, in the task's order, with no types: a twin takes them from its task",
  },
  'twin-loops': {
    code: 0x1e,
    message: 'this twin is not shown to end where its task is',
    severity: 'error',
    fix: 'a twin that loops where its task returns is a wrong answer, not a faster one',
  },
  'twin-cycle': {
    code: 0x1f,
    message: 'these twins call each other in a cycle',
    severity: 'error',
    fix: 'break the cycle: a twin of one task may call another task, but not one whose twin calls back',
  },
  'guard-impure': {
    code: 0x20,
    message: "this twin's run-time check is not pure",
    severity: 'error',
    fix: 'a `hook test` decides which implementation runs, so it may not change anything or call native code',
  },
  'twin-choice': {
    code: 0x22,
    message: 'this choice of implementation cannot be made',
    severity: 'error',
    fix: 'choose a twin the task has, eligible on this target, whose conditions the selection pass can honor',
  },
  'ease-unknown': {
    code: 0x21,
    message: 'this relaxation is not one Term defines',
    severity: 'error',
    fix: 'the relaxations are `float-order` and `float-fused` (note/term/optimize/words.md)',
  },
  // A supervision tree OTP would start and then misbehave: a `transient` worker restarts only when it raises, so one
  // whose work can raise nothing never restarts, and is a `temporary` under a misleading name (check/supervise.ts)
  'dead-restart': {
    code: 0x23,
    message: 'this transient worker can never restart',
    severity: 'error',
    fix: 'make it `temporary` if it is meant to run once, or let its work raise the failure it should restart on',
  },
  // `mark private` on a task makes it visible only inside the file that defines it. Until 2026-10-02 the mark was
  // read and nothing held anyone to it: names are package-global, so another file could call the task, or `find`
  // it in a `load`, and the output exported it (check/private.ts).
  'private-name': {
    code: 0x24,
    message: 'this name is private to another file',
    severity: 'error',
    fix: 'remove `mark private` from the definition, or use it only from the file that defines it',
  },
  // `note private` is the old spelling. Still honored, so code written before the change keeps building.
  'note-private': {
    code: 0x25,
    message: '`note private` is the old spelling of `mark private`',
    severity: 'warning',
    fix: 'write `mark private`: privacy is a mark the compiler enforces, and a `note` is documentation',
  },
  // a call to an async task OUTSIDE every task (a top-level `host`, a component's body, a closure in either that is
  // not async), where nothing can wait for it: it hands back a pending value. `tick` says that is meant. Behind
  // the await switch (check/effects.ts, `setAwaitOutsideTasks`). note/term/plan/await-by-default-and-mark-metadata.md
  'async-outside-task': {
    code: 0x27,
    message: 'a call to an async task outside any task, where nothing waits for it',
    severity: 'error',
    fix: 'move the call into a task, or write `tick` before it to start it without waiting',
  },
  // `note async`, `note unsafe`, `note draft` ...: metadata is `mark` since 2026-10-02, and `note <word>` is the
  // old spelling. Still read the same (the mill mints both as one form), so code written before keeps building.
  // note/term/plan/await-by-default-and-mark-metadata.md, section 4
  'note-metadata': {
    code: 0x26,
    message: '`note` is the old spelling of metadata, which is `mark`',
    severity: 'warning',
    fix: 'write `mark` for the `note`: `term lint --fix` rewrites it, and `note` is left for documentation',
  },
  // A task that promises a value and has a path that ends without `back`. It built, and the TypeScript it emitted fell
  // out of the bottom with `undefined` where the type said a value (guides: language/branching, check/returns.ts)
  'missing-back': {
    code: 0x28,
    message: 'a path through this task ends without sending a value back',
    severity: 'error',
    fix: 'end every path with `back`, or add a `hook miss` that does',
  },
  // a `make pattern, <...>` literal that @term/base/pattern's reader refuses: it built, and the program raised
  // `pattern-mismatch` the first time it ran the pattern (check/patterns.ts)
  'pattern-mismatch': {
    code: 0x29,
    message: 'this pattern literal is not a pattern',
    severity: 'error',
    fix: 'correct the pattern at the position named, or build the text at run time and handle `pattern-mismatch`',
  },
  // a `make pattern, <...>` literal that needs a backtracking matcher: tier C wherever the platform's engine cannot run
  // it safely, the one tier whose work can grow faster than its input, held to a budget proportional to the input and
  // raising `pattern-budget` past it (note/term/stdlib/regex-engine.md)
  'pattern-backtracks': {
    code: 0x2a,
    message: 'this pattern needs a backtracking matcher',
    severity: 'warning',
    fix: 'rewrite it without the part named, or handle `pattern-budget` where it is searched',
  },
  // The `halt <form>` lines on a task's signature do not match what it raises: a name that is no exception, one the
  // body never raises, or a raise the lines leave out (a broken promise). All three were `type-mismatch`, and the
  // second said `"absence" is not an exception form`, because the build drops an exception nothing raises (guides:
  // language/errors, library/exceptions, 2026-10-04)
  'raise-bound': {
    code: 0x2b,
    message: "this task's raise bound does not match what it can raise",
    severity: 'error',
    fix: 'bound exactly what the body can raise. `term roll task` lists what each task raises',
  },
  // A `view` document that uses what a document may not: code, a macro it cannot reach, a fuse cycle, too large an
  // expansion. Each message says what is allowed instead, and the generic bracket-and-indentation note under it was
  // advice about a different problem (guides: commands/view, 2026-10-04)
  'document-refused': {
    code: 0x2d,
    message: 'this document uses something a document may not',
    severity: 'error',
    fix: 'write what the message names. A document places views and reads data, and code goes in a file of the `code` role',
  },
  // A `hook miss` arm that answers one case of the match or none: listing the case says more, and a case added
  // later goes to the arm without a word (note/term/gaps/decisions.md, the catch-all)
  'thin-catch-all': {
    code: 0x2e,
    message: 'this `hook miss` arm answers one case or none',
    severity: 'warning',
    fix: 'list the case it answers, or remove the arm',
  },
  // A match arm's field named like a variable already in scope, which it hides for the whole arm without a word
  // (guides: language/matching, 2026-10-04)
  'arm-shadow': {
    code: 0x2f,
    message: "this arm's field hides a variable already in scope",
    severity: 'warning',
    fix: 'rename the field with a `link` under the case, or rename the outer variable',
  },
  // A `tell` for an exception no task in the build can raise: the stale customer wording the roll exists to catch.
  // It was `type-mismatch` (guides: language/errors, commands/roll, 2026-10-04)
  'stale-tell': {
    code: 0x2c,
    message: 'this tell is for an exception nothing in the build raises',
    severity: 'error',
    fix: 'remove the tell, or raise the exception where it is meant. `term roll exception` lists what each task raises',
  },
  // An async task handed to a parameter whose type is a task that is not: the callee calls it without waiting, and
  // reads the pending value as the result. TypeScript printed `[object Promise]` (guides: language/async, 2026-10-04)
  // A `load` of another deck's module that nothing answers: the deck is not in `link/`. It built no message of its
  // own, and the first use of an imported name failed as `unknown-name`, far from the cause (guides:
  // packages/install, 2026-10-04)
  'unresolved-load': {
    code: 0x31,
    message: 'this load names a deck that is not installed',
    severity: 'error',
    fix: 'run `term load`, or `term link <path>` for a working copy',
  },
  'async-argument': {
    code: 0x30,
    message: 'an async task is passed where the parameter takes a task that is not async',
    severity: 'error',
    fix: 'write `mark async` under the parameter\'s `like task`, so the calls to it are awaited',
  },
  'dock-shadow': {
    code: 0x33,
    message: 'a local named like a docked module hides it',
    severity: 'warning',
    fix: 'rename the local, so `name/...` reaches the module',
  },
  'look-tint': {
    code: 0x32,
    message: 'this tint is not a CSS color',
    severity: 'error',
    fix: 'give the color space its values: `tint rgb, 24, 24, 27`, or `tint hex, <fafafa>`',
  },
} satisfies Record<string, CatalogEntry>

export type DiagnosticName = keyof typeof CATALOG

export type DiagnosticInput = {
  file: string
  span: Span
  hint?: string
  message?: string
  markers?: Marker[]
}

// Build a diagnostic from a catalog name. Cheap: just a record, rendered lazily.
export function diagnose(
  name: DiagnosticName,
  input: DiagnosticInput,
): Diagnostic {
  const entry = CATALOG[name]

  return {
    code: entry.code,
    name,
    message: input.message ?? entry.message,
    file: input.file,
    span: input.span,
    markers: input.markers ?? [{ span: input.span }],
    // a specific hint if given, otherwise the catalog's default fix, so every diagnostic suggests a remedy
    hint: input.hint ?? entry.fix,
    severity: entry.severity,
  }
}

// A thrown diagnostic, for the strict (non-tolerant) path.
export class DiagnosticError extends Error {
  constructor(public diagnostic: Diagnostic) {
    super(diagnostic.message)
  }
}

// the code a frame prints: a lint rule's own (`L023`), else the compiler's catalog code in hexadecimal (`0007`)
function codeOf(diagnostic: Diagnostic): string {
  return diagnostic.rule ?? diagnostic.code.toString(16).padStart(4, '0')
}

// Render a diagnostic against the source lines: a gutter, the offending line, a red range, a caret underline, a
// few context lines, and an optional hint.
export function render(
  diagnostic: Diagnostic,
  lines: string[],
  color = chalk.level > 0,
): string {
  const paint = color
    ? {
        red: chalk.red,
        yellow: chalk.yellow,
        dim: chalk.dim,
        bold: chalk.bold,
        bright: chalk.whiteBright,
      }
    : {
        red: identity,
        yellow: identity,
        dim: identity,
        bold: identity,
        bright: identity,
      }

  const accent =
    diagnostic.severity === 'warning' ? paint.yellow : paint.red

  const { span } = diagnostic
  const out: string[] = []

  // header shows the readable name and the stable code, e.g. `error[type-mismatch 0007]`
  const heading = `${diagnostic.severity}[${diagnostic.name} ${codeOf(diagnostic)}]`

  out.push(
    `${paint.bold(accent(heading))}: ${paint.bold(diagnostic.message)}`,
  )
  out.push(
    `  ${paint.dim('-->')} ${diagnostic.file}:${span.start.line + 1}:${
      span.start.column + 1
    }`,
  )

  const first = Math.max(0, span.start.line - 2)
  const last = Math.min(lines.length - 1, span.end.line + 2)
  const width = String(last + 1).length
  const rail = `${' '.repeat(width)} ${paint.dim('|')}`

  out.push(rail)

  for (let i = first; i <= last; i++) {
    const text = lines[i] ?? ''
    const number = String(i + 1).padStart(width, ' ')

    if (i === span.start.line) {
      const stop =
        span.end.line === span.start.line
          ? span.end.column
          : text.length

      const before = text.slice(0, span.start.column)
      const middle = text.slice(span.start.column, stop)
      const after = text.slice(stop)
      out.push(
        `${paint.dim(number)} ${paint.dim('|')} ${paint.bright(
          before,
        )}${accent(middle)}${paint.bright(after)}`,
      )

      const carets = `${' '.repeat(span.start.column)}${'^'.repeat(
        Math.max(1, stop - span.start.column),
      )}`

      const label = diagnostic.markers[0]?.label
        ? ` ${diagnostic.markers[0].label}`
        : ''

      out.push(
        `${' '.repeat(width)} ${paint.dim('|')} ${accent(
          carets + label,
        )}`,
      )
    } else {
      out.push(
        `${paint.dim(number)} ${paint.dim('|')} ${paint.dim(text)}`,
      )
    }
  }

  out.push(rail)

  // related (secondary) markers: point at other relevant places, e.g. where a type was first fixed
  for (let i = 1; i < diagnostic.markers.length; i++) {
    const marker = diagnostic.markers[i]!
    const where = `${diagnostic.file}:${marker.span.start.line + 1}:${
      marker.span.start.column + 1
    }`

    out.push(
      `  ${paint.dim('-->')} ${where}${
        marker.label ? `: ${paint.dim(marker.label)}` : ''
      }`,
    )
  }

  if (diagnostic.hint) {
    out.push(` ${paint.bold('hint')}: ${diagnostic.hint}`)
  }

  return out.join('\n')
}

// the inline source snippet for a span: a gutter, the offending line, and a caret underline, optionally indented
function sourceSnippet(
  lines: string[],
  span: Span,
  accent: (s: string) => string,
  dim: (s: string) => string,
  bright: (s: string) => string,
  indent: string,
): string[] {
  const out: string[] = []
  const first = Math.max(0, span.start.line - 1)
  const last = Math.min(lines.length - 1, span.end.line + 1)
  const width = String(last + 1).length

  for (let i = first; i <= last; i++) {
    const text = lines[i] ?? ''
    const number = String(i + 1).padStart(width, ' ')

    if (i === span.start.line) {
      const stop =
        span.end.line === span.start.line
          ? span.end.column
          : text.length

      out.push(
        `${indent}${dim(`${number} |`)} ${bright(
          text.slice(0, span.start.column),
        )}${accent(text.slice(span.start.column, stop))}${bright(
          text.slice(stop),
        )}`,
      )

      const carets = `${' '.repeat(span.start.column)}${'^'.repeat(
        Math.max(1, stop - span.start.column),
      )}`

      out.push(
        `${indent}${dim(`${' '.repeat(width)} |`)} ${accent(carets)}`,
      )
    } else {
      out.push(`${indent}${dim(`${number} |`)} ${dim(text)}`)
    }
  }

  return out
}

// The beautiful structured renderer, in the kink style: a titled error with code and host, then site/call frames,
// each followed by its inline source snippet. Keywords are bare words, values sit in <...> (no colon separators;
// colons appear only inside file:line:col). The richest, most debuggable form.
export function renderKink(
  diagnostic: Diagnostic,
  lines: string[],
  color = chalk.level > 0,
): string {
  const paint = color
    ? {
        red: chalk.red,
        cyan: chalk.cyan,
        dim: chalk.dim,
        bold: chalk.bold,
        white: chalk.white,
        bright: chalk.whiteBright,
        yellow: chalk.yellow,
      }
    : {
        red: identity,
        cyan: identity,
        dim: identity,
        bold: identity,
        white: identity,
        bright: identity,
        yellow: identity,
      }

  const accent =
    diagnostic.severity === 'warning' ? paint.yellow : paint.red

  const wrap = (open: string, value: string, close = '>') =>
    `${paint.dim(open)}${value}${paint.dim(close)}`

  const out: string[] = []

  const word = diagnostic.severity === 'warning' ? 'warn' : 'kink'
  // title: the keyword, then the message in <...>. Order, most-relevant first: the message, then where it is (site +
  // source frame), then the human note, then the machine-facing name and code.
  out.push(
    `${accent(word)} ${wrap(
      '<',
      accent(paint.bold(diagnostic.message)),
    )}`,
  )

  diagnostic.markers.forEach((marker, i) => {
    const here = marker.span
    const location = `${diagnostic.file}:${here.start.line + 1}:${
      here.start.column + 1
    }`

    out.push(
      `  ${paint.dim('site')} ${wrap('<', paint.bright(location))}`,
    )

    if (marker.label) {
      out.push(
        `    ${paint.dim('call')} ${wrap(
          '<',
          paint.white(marker.label),
        )}`,
      )
    } else if (i > 0) {
      out.push(
        `    ${paint.dim('call')} ${wrap('<', paint.white('related'))}`,
      )
    }

    out.push(
      ...sourceSnippet(
        lines,
        here,
        accent,
        paint.dim,
        paint.bright,
        '    ',
      ),
    )
  })

  if (diagnostic.hint) {
    out.push(
      `  ${paint.dim('note')} ${wrap('<', paint.dim(diagnostic.hint))}`,
    )
  }

  out.push(
    `  ${paint.dim('name')} ${wrap('<', paint.dim(diagnostic.name))}`,
  )
  out.push(
    `  ${paint.dim('code')} ${wrap(
      '<',
      paint.cyan(codeOf(diagnostic)),
    )}`,
  )

  return out.join('\n')
}

// Render a whole batch of diagnostics with a summary count. The single thing to call to show problems to a user.
export function report(
  diagnostics: Diagnostic[],
  lines: string[],
  color = chalk.level > 0,
): string {
  if (diagnostics.length === 0) {
    return 'no problems found'
  }

  const errors = diagnostics.filter(d => d.severity === 'error').length
  const warnings = diagnostics.filter(
    d => d.severity === 'warning',
  ).length

  const parts: string[] = []

  if (errors) {
    parts.push(`${errors} error${errors === 1 ? '' : 's'}`)
  }

  if (warnings) {
    parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  }

  const body = diagnostics
    .map(d => renderKink(d, lines, color))
    .join('\n\n')

  return `${body}\n\n${parts.join(', ')}`
}

// Machine-readable form for the language server and CI.
export function toJson(diagnostic: Diagnostic): string {
  return JSON.stringify({
    code: codeOf(diagnostic),
    name: diagnostic.name,
    message: diagnostic.message,
    file: diagnostic.file,
    span: diagnostic.span,
    hint: diagnostic.hint,
    severity: diagnostic.severity,
  })
}

function identity(s: string): string {
  return s
}

// did-you-mean: nearest known name by edit distance, within a small threshold.
export function nearest(
  name: string,
  known: string[],
): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity

  for (const candidate of known) {
    const d = editDistance(name, candidate)

    if (d < bestDistance) {
      bestDistance = d
      best = candidate
    }
  }

  const threshold = Math.max(2, Math.floor(name.length / 3))

  return best !== undefined && bestDistance <= threshold
    ? best
    : undefined
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const grid = new Array<number>(rows * cols)

  for (let i = 0; i < rows; i++) {
    grid[i * cols] = i
  }

  for (let j = 0; j < cols; j++) {
    grid[j] = j
  }

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      grid[i * cols + j] = Math.min(
        grid[(i - 1) * cols + j]! + 1,
        grid[i * cols + (j - 1)]! + 1,
        grid[(i - 1) * cols + (j - 1)]! + cost,
      )
    }
  }

  return grid[rows * cols - 1]!
}
