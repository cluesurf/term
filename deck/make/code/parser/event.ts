// The structure pass. The token list to a flat stream of open and close events (group, name, text, interpolation,
// indent) plus content events (chunk, integer, decimal, radix). Resolves indentation into nesting levels, commas
// into sibling groups, and opens and closes names, interpolations, and texts. Detects the structural errors.
// Browser-safe.

import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Token, TokenList } from '@term/make/code/parser/token'

export type EventKind =
  | 'open-group'
  | 'close-group'
  | 'open-name'
  | 'close-name'
  | 'open-text'
  | 'close-text'
  | 'open-interpolation'
  | 'close-interpolation'
  | 'open-indent'
  | 'close-indent'
  | 'read-chunk'
  | 'read-integer'
  | 'read-decimal'
  | 'read-radix'
  | 'read-comment'

// what a name's last token is followed by on its line: an opening parenthesis (`f(a)`), an empty pair (`f()`), or
// neither (absent). The mill reads it to tell `f()` from `f`, and a keyword's call from the keyword. It is the one
// thing a reader once followed a token's link forward for, so it is read off the token list here instead.
export type Follows = 'paren' | 'empty-parens'

// An event carries the span and text of the token it was made from, not the token: the text may differ (a text
// literal's chunk is trimmed of its indentation, and merged with the next line's), and nothing after this pass reads a
// token
export type Event =
  | { kind: 'open-group' }
  | { kind: 'close-group' }
  | { kind: 'open-name' }
  | { kind: 'close-name' }
  | { kind: 'open-text'; text: string; span: Span }
  | { kind: 'close-text'; span: Span }
  | { kind: 'open-interpolation'; span: Span; depth: number }
  | { kind: 'close-interpolation'; span: Span }
  | { kind: 'open-indent' }
  | { kind: 'close-indent' }
  | { kind: 'read-chunk'; text: string; span: Span; follows?: Follows }
  | { kind: 'read-integer'; text: string; span: Span; value: number }
  | { kind: 'read-decimal'; text: string; span: Span; value: number }
  | {
      kind: 'read-radix'
      text: string
      span: Span
      value: number
      radix: number
    }
  | { kind: 'read-comment'; text: string; span: Span }

// the events, and every structural mistake found on the way: none when the text is well formed
export type EventResult = { events: Event[]; diagnostics: Diagnostic[] }

enum Context {
  Root = 'root',
  Name = 'name',
  Text = 'text',
  Interpolation = 'interpolation',
  Group = 'group',
  Indent = 'indent',
  // inside `(` ... `)`: the children of the group whose head the paren follows. A name inside opens a child group,
  // a comma closes the current child, and `)` closes back through the frame and then the owning group. Lives on
  // one line. This is what lets `h(x,h(y,1),h(w,2))` be one tree, the compact spelling of Term data.
  Paren = 'paren',
}

type ContextFrame = { kind: Context; token?: Token }
type IndentFrame = { depth: number; ownLine?: boolean; used: boolean }

// Whether a comma after a part that opened no level (a literal, or a call closed by its own parenthesis) stays at
// that part's level. `stays` is the grammar since 2026-10-02: `want hold, is-equal get(found, 1), 14` gives
// `is-equal` two arguments. `pops` reproduces the superseded reading, where such a comma popped the level ABOVE the
// part, and `call` stays after a closed call only. Only a migration measuring the corpus both ways passes anything
// else (task/term/comma-migrate.ts, which moved every file the change would have re-read, 114 of them). It was a
// module-wide switch until 2026-10-05, and a parameter now, so the module holds no state.
//
// The comma itself pops ONE level. The rule before 2026-08-30 closed every level back to the line's head; a switch
// kept it reachable for that migration, and nothing had used it since.
export type CommaAfterLeaf = 'stays' | 'call' | 'pops'

export function buildEvents(tokens: TokenList, afterLeafRule: CommaAfterLeaf = 'stays'): EventResult {
  const events: Event[] = []
  const contexts: ContextFrame[] = [{ kind: Context.Root }]
  const indents: IndentFrame[] = [
    { depth: 0, used: true, ownLine: true },
  ]

  const diagnostics: Diagnostic[] = []

  let atLineStart = true
  let lastDepth = 0
  // the last part written was a leaf: a literal, or a call its own `)` closed. Read only by `comma`.
  let afterLeaf: '' | 'literal' | 'call' = ''

  const top = () => contexts[contexts.length - 1]
  const push = (frame: ContextFrame) => contexts.push(frame)
  const pop = () => contexts.pop()
  const indent = () => indents[indents.length - 1]!
  const pushIndent = (move = 0) =>
    indents.push({ depth: lastDepth + move, used: true, ownLine: true })

  // never pop the root frame (depth 0): an over-dedent on malformed input must degrade to a diagnostic, not crash
  const popIndent = () => {
    if (indents.length > 1) {
      indents.pop()
    }
  }

  function fail(
    name: 'invalid-nesting' | 'invalid-indentation' | 'syntax-error',
    token: Token,
    hint?: string,
  ) {
    diagnostics.push(
      diagnose(name, { file: tokens.file, span: token.span, hint }),
    )
  }

  // the token list, walked by index: a step either way is `list[at - 1]` and `list[at + 1]`
  const list = tokens.list
  let at = 0
  const before = (): Token | undefined => list[at - 1]
  const after = (step = 1): Token | undefined => list[at + step]

  for (; at < list.length; at++) {
    const token = list[at]!
    const leafBefore = afterLeaf
    afterLeaf = ''

    switch (token.kind) {
      case 'open-brace':
        openInterpolation(token)
        break
      case 'close-brace':
        closeInterpolation()
        break
      case 'open-angle':
        atLineStart = false
        openText(token)
        break
      case 'close-angle':
        closeText(token)
        afterLeaf = 'literal'
        break
      case 'open-paren':
        if (top()?.kind === Context.Name) {
          pop()
          events.push({ kind: 'close-name' })
        }

        push({ kind: Context.Paren, token })
        break
      case 'close-paren':
        afterLeaf = closeParen() ? 'call' : ''
        break
      case 'comma':
        comma(leafBefore)
        break
      case 'comment':
        // a comment is trivia: keep it in the stream so the tree builder can attach it to the CST (for the
        // formatter and inline lint suppression). It does not affect grouping or indentation.
        atLineStart = false
        events.push({ kind: 'read-comment', text: token.text, span: token.span })
        break
      case 'decimal':
        atLineStart = false
        decimal(token)
        afterLeaf = 'literal'
        break
      case 'radix':
        atLineStart = false
        radix(token)
        afterLeaf = 'literal'
        break
      case 'space':
        space(token)
        afterLeaf = leafBefore
        break
      case 'newline':
        closeLine()
        atLineStart = true
        break
      case 'chunk':
        atLineStart = false
        chunk(token)
        break
      case 'name':
        atLineStart = false
        name(token)
        break
      case 'integer':
        atLineStart = false
        integer(token)
        afterLeaf = 'literal'
        break
      default:
        break
    }
  }

  closeLine()

  return { events, diagnostics }

  // Validate the first content node on a line.
  function startContent() {
    const frame = indent()

    if (atLineStart) {
      atLineStart = false

      if (frame.ownLine !== false) {
        frame.ownLine = true
      }
    } else if (!frame.used) {
      frame.ownLine = false
    }

    frame.used = true
  }

  function space(token: Token) {
    while (top()?.kind === Context.Name) {
      events.push({ kind: 'close-name' })
      pop()
    }

    if (atLineStart) {
      atLineStart = false

      const frame = indent()

      let depth = Math.floor(token.text.length / 2)

      if (token.text.length % 2 !== 0) {
        fail(
          'invalid-nesting',
          token,
          'indentation must be a multiple of two spaces',
        )
        depth = frame.depth + 1
      } else if (depth > lastDepth + 1) {
        if (indents.length === 1) {
          fail(
            'invalid-indentation',
            token,
            'indent one level deeper than the parent, not more',
          )
        }

        depth = lastDepth + 1
      } else if (depth < frame.depth) {
        depth = frame.depth + 1
      }

      let diff = depth - frame.depth

      while (diff-- > 0) {
        contexts.push({ kind: Context.Indent })
        events.push({ kind: 'open-indent' })
      }

      lastDepth = depth
    } else if (before()?.kind === 'integer') {
      // a number is a leaf and cannot have a following node on the same line
      fail(
        'invalid-nesting',
        token,
        'a number is a value, so nothing can nest after it on the same line',
      )
    }
  }

  function openText(token: Token) {
    pushIndent(1)
    push({ kind: Context.Text })
    events.push({ kind: 'open-text', text: token.text, span: token.span })
    indent().ownLine = endsLineWithNewline()
  }

  // the literal opening here ends its line, so its content is the indented lines below
  function endsLineWithNewline(): boolean {
    const next = after()

    if (next?.kind === 'chunk') {
      return Boolean(/^\s*\n$/.exec(next.text))
    }

    return false
  }

  function closeText(token: Token) {
    events.push({ kind: 'close-text', span: token.span })
    pop()
    popIndent()
  }

  function decimal(token: Token) {
    startContent()
    events.push({
      kind: 'read-decimal',
      text: token.text,
      span: token.span,
      value: parseFloat(token.text),
    })
  }

  function radix(token: Token) {
    startContent()

    const found = /^0([xXbBoOuU])([0-9a-fA-F]+)/.exec(token.text)

    if (found) {
      const base = found[1]!.toLowerCase()
      // 0x / 0u are hex (0u is a unicode code point, value = the code point), 0b binary, 0o octal
      const radixValue = base === 'b' ? 2 : base === 'o' ? 8 : 16
      events.push({
        kind: 'read-radix',
        text: token.text,
        span: token.span,
        value: parseInt(found[2]!, radixValue),
        radix: radixValue,
      })
    } else {
      fail(
        'syntax-error',
        token,
        'this looks like a based number but is malformed',
      )
    }
  }

  function chunk(token: Token) {
    const frame = indent()
    // Only a chunk that STARTS its line carries the literal's own indentation. A chunk that follows an
    // interpolation on the same line (`x {{foo}} y`) begins mid-line, and slicing `depth * 2` characters off it
    // ate the text outright — ` y` is two characters, so the `y` vanished with no error. It is trimmed instead,
    // which is what puts `}}or{{` next to each other in text-multiline.tree's expected output.
    const previous = before()
    const startsLine = !previous || previous.span.end.line < token.span.start.line
    let text = token.text

    if (frame.ownLine) {
      text = startsLine ? text.slice(frame.depth * 2).trimEnd() : text.trim()
    }

    const last = events[events.length - 1]

    // merge consecutive chunks inside a multiline text to keep things clean: the last event is replaced by one
    // holding both texts, at the first one's span
    if (last?.kind === 'read-chunk' && frame.ownLine) {
      if (text) {
        const merged = last.text ? (last.text.endsWith('\n') ? `${last.text}${text}` : `${last.text} ${text}`) : text
        events[events.length - 1] = { ...last, text: merged }
      } else if (after()?.kind === 'chunk') {
        events[events.length - 1] = { ...last, text: `${last.text}\n\n` }
      }
    } else {
      events.push({ kind: 'read-chunk', text, span: token.span })
    }
  }

  function integer(token: Token) {
    startContent()
    events.push({
      kind: 'read-integer',
      text: token.text,
      span: token.span,
      // thousand separators are presentation only: `2,440,588` is the number 2440588
      value: parseInt(token.text.replace(/,/g, ''), 10),
    })
  }

  // A comma POPS ONE LEVEL: the part after it is a sibling of the part before it, however deep that part had
  // nested. So `foo bar baz bang boom, a b c, d e f` puts `a` beside `boom` (both under `bang`) and `d` beside
  // `c` (both under `b`), because `boom` was the deepest node when the first comma arrived and `c` was when the
  // second did. Only a space nests, and a comma undoes exactly one space.
  //
  // This is the rule the tree grammar is specified by. The ported parser had a comma close ALL the way back to
  // the head of the line instead, which agrees with the one-level rule whenever the preceding part is a single
  // token (`a b, c, d`, `add 1, 2`, `take x, like text`) and silently disagrees the moment it is not — which is
  // most of the interesting cases, and is why every fixture carried over from the original implementation still
  // passed. See test/parser/file/comma-depth.tree.
  function comma(leafBefore: '' | 'literal' | 'call') {
    if (top()?.kind === Context.Name) {
      pop()
      events.push({ kind: 'close-name' })
    }

    // A literal and a call closed by its own `)` open no level, so there is no level of theirs for the comma to
    // pop. The part after the comma stays at THEIR level: `want hold, is-equal get(found, 1), 14` gives
    // `is-equal` two arguments, and `code <1>, <2>` gives `code` two children.
    if (
      (leafBefore === 'call' && afterLeafRule !== 'pops') ||
      (leafBefore === 'literal' && afterLeafRule === 'stays')
    ) {
      return
    }

    if (top()?.kind !== Context.Group) {
      return
    }

    // the line's head, or a parenthesis owner, is the floor: a comma never escapes past it, so the head stays
    // open to receive what follows
    const below = contexts[contexts.length - 2]

    if (!below || below.kind === Context.Indent || below.kind === Context.Root) {
      return
    }

    pop()
    events.push({ kind: 'close-group' })
  }

  function name(token: Token) {
    openName()

    if (token.text.includes('/')) {
      const followsClose = before()?.kind === 'close-brace'
      const segments = token.text.split('/')

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]!

        if (segment.startsWith('-') && !(i === 0 && followsClose)) {
          fail(
            'syntax-error',
            token,
            'a path segment cannot start with a dash',
          )
          break
        }

        const q = segment.indexOf('?')

        if (q !== -1 && q !== segment.length - 1) {
          fail(
            'syntax-error',
            token,
            'the optional mark ? must be at the end of a segment',
          )
          break
        }
      }
    }

    const follows = followsOf()
    events.push(follows ? { kind: 'read-chunk', text: token.text, span: token.span, follows } : { kind: 'read-chunk', text: token.text, span: token.span })
  }

  // what the name token here is followed by: `(` then `)`, `(` alone, or neither
  function followsOf(): Follows | undefined {
    if (after()?.kind !== 'open-paren') {
      return undefined
    }

    return after(2)?.kind === 'close-paren' ? 'empty-parens' : 'paren'
  }

  function openName() {
    const previousKind = before()?.kind

    if (
      previousKind === undefined ||
      previousKind === 'newline' ||
      previousKind === 'comma' ||
      previousKind === 'open-brace' ||
      previousKind === 'open-paren' ||
      previousKind === 'space'
    ) {
      events.push({ kind: 'open-group' })
      push({ kind: Context.Group })
      startContent()
      events.push({ kind: 'open-name' })
      push({ kind: Context.Name })
    }
  }

  function openInterpolation(token: Token) {
    const previousKind = before()?.kind

    if (
      previousKind === undefined ||
      previousKind === 'newline' ||
      previousKind === 'space'
    ) {
      push({ kind: Context.Group })
      events.push({ kind: 'open-group' })
      push({ kind: Context.Name })
      events.push({ kind: 'open-name' })
    }

    push({ kind: Context.Interpolation, token })
    events.push({
      kind: 'open-interpolation',
      span: token.span,
      depth: token.text.length,
    })
    pushIndent(1)
  }

  // Close a parenthesis: everything opened inside it, the paren frame, then the group that owns it. A `)` with no
  // open paren on the line closes what it can, as before, so a stray one degrades rather than crashes.
  function closeParen(): boolean {
    const owned = contexts.some(frame => frame.kind === Context.Paren)

    walk: while (true) {
      switch (top()?.kind) {
        case Context.Indent:
          events.push({ kind: 'close-indent' })
          pop()
          break
        case Context.Group:
          events.push({ kind: 'close-group' })
          pop()
          break
        case Context.Name:
          events.push({ kind: 'close-name' })
          pop()
          break
        case Context.Paren:
          pop()
          break walk
        default:
          break walk
      }
    }

    // the group whose head the paren followed
    if (owned && top()?.kind === Context.Group) {
      events.push({ kind: 'close-group' })
      pop()

      return true
    }

    return false
  }

  function closeInterpolation() {
    walk: while (true) {
      const frame = top()

      switch (frame?.kind) {
        case Context.Name:
          events.push({ kind: 'close-name' })
          pop()
          break
        case Context.Indent:
          events.push({ kind: 'close-indent' })
          pop()
          break
        case Context.Group:
          events.push({ kind: 'close-group' })
          pop()
          break
        case Context.Interpolation:
          // at the span of the brace that opened it, as before
          events.push({
            kind: 'close-interpolation',
            span: frame.token!.span,
          })
          pop()
          break walk
        default:
          break walk
      }
    }

    popIndent()
  }

  // Close everything still open at the end of a line.
  function closeLine() {
    walk: while (true) {
      switch (top()?.kind) {
        case Context.Group:
          events.push({ kind: 'close-group' })
          pop()
          break
        case Context.Indent:
          events.push({ kind: 'close-indent' })
          pop()
          break
        case Context.Name:
          events.push({ kind: 'close-name' })
          pop()
          break
        case Context.Paren: {
          // a parenthesis lives on one line: one left open is a syntax error at the line's end
          const frame = top()!
          pop()

          if (frame.token) {
            fail(
              'syntax-error',
              frame.token,
              'a parenthesis must be closed on the line it opens',
            )
          }

          break
        }
        case Context.Root:
          break walk
        default:
          break walk
      }
    }
  }
}
