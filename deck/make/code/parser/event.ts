// The structure pass. The token list to a flat stream of open and close events (group, name, text, interpolation,
// indent) plus content events (chunk, integer, decimal, radix). Resolves indentation into nesting levels, commas
// into sibling groups, and opens and closes names, interpolations, and texts. Detects the structural errors.
// Browser-safe.

import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import { diagnose } from '@cluesurf/make/code/parser/diagnostic'
import type { Token, TokenList } from '@cluesurf/make/code/parser/token'
import { TokenKind } from '@cluesurf/make/code/parser/token'

export enum EventKind {
  OpenGroup = 'open-group',
  CloseGroup = 'close-group',
  OpenName = 'open-name',
  CloseName = 'close-name',
  OpenText = 'open-text',
  CloseText = 'close-text',
  OpenInterpolation = 'open-interpolation',
  CloseInterpolation = 'close-interpolation',
  OpenIndent = 'open-indent',
  CloseIndent = 'close-indent',
  Chunk = 'chunk',
  Integer = 'integer',
  Decimal = 'decimal',
  Radix = 'radix',
  Comment = 'comment',
}

export type Event =
  | { kind: EventKind.OpenGroup }
  | { kind: EventKind.CloseGroup }
  | { kind: EventKind.OpenName }
  | { kind: EventKind.CloseName }
  | { kind: EventKind.OpenText; token: Token }
  | { kind: EventKind.CloseText; token: Token }
  | { kind: EventKind.OpenInterpolation; token: Token; depth: number }
  | { kind: EventKind.CloseInterpolation; token: Token }
  | { kind: EventKind.OpenIndent }
  | { kind: EventKind.CloseIndent }
  | { kind: EventKind.Chunk; token: Token }
  | { kind: EventKind.Integer; token: Token; value: number }
  | { kind: EventKind.Decimal; token: Token; value: number }
  | {
      kind: EventKind.Radix
      token: Token
      value: number
      radix: number
    }
  | { kind: EventKind.Comment; token: Token }

export type EventStream = TokenList & { events: Array<Event> }

export type EventResult =
  | { ok: true; stream: EventStream }
  | { ok: false; diagnostics: Array<Diagnostic> }

enum Context {
  Root = 'root',
  Name = 'name',
  Text = 'text',
  Interpolation = 'interpolation',
  Group = 'group',
  Indent = 'indent',
}

type ContextFrame = { kind: Context; token?: Token }
type IndentFrame = { depth: number; ownLine?: boolean; used: boolean }

export function buildEvents(tokens: TokenList): EventResult {
  const events: Array<Event> = []
  const contexts: Array<ContextFrame> = [{ kind: Context.Root }]
  const indents: Array<IndentFrame> = [
    { depth: 0, used: true, ownLine: true },
  ]
  const diagnostics: Array<Diagnostic> = []

  let atLineStart = true
  let lastDepth = 0

  const top = () => contexts[contexts.length - 1]
  const push = (frame: ContextFrame) => contexts.push(frame)
  const pop = () => contexts.pop()
  const indent = () => indents[indents.length - 1]!
  const pushIndent = (move = 0) =>
    indents.push({ depth: lastDepth + move, used: true, ownLine: true })
  // never pop the root frame (depth 0): an over-dedent on malformed input must degrade to a diagnostic, not crash
  const popIndent = () => {
    if (indents.length > 1) indents.pop()
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

  let token = tokens.head
  if (token) {
    do {
      switch (token.kind) {
        case TokenKind.OpenBrace:
          openInterpolation(token)
          break
        case TokenKind.CloseBrace:
          closeInterpolation()
          break
        case TokenKind.OpenAngle:
          atLineStart = false
          openText(token)
          break
        case TokenKind.CloseAngle:
          closeText(token)
          break
        case TokenKind.OpenParen:
          if (top()?.kind === Context.Name) {
            pop()
            events.push({ kind: EventKind.CloseName })
          }
          break
        case TokenKind.CloseParen:
          closeParen()
          break
        case TokenKind.Comma:
          comma()
          break
        case TokenKind.Comment:
          // a comment is trivia: keep it in the stream so the tree builder can attach it to the CST (for the
          // formatter and inline lint suppression). It does not affect grouping or indentation.
          atLineStart = false
          events.push({ kind: EventKind.Comment, token })
          break
        case TokenKind.Decimal:
          atLineStart = false
          decimal(token)
          break
        case TokenKind.Radix:
          atLineStart = false
          radix(token)
          break
        case TokenKind.Space:
          space(token)
          break
        case TokenKind.Newline:
          closeLine()
          atLineStart = true
          break
        case TokenKind.Chunk:
          atLineStart = false
          chunk(token)
          break
        case TokenKind.Name:
          atLineStart = false
          name(token)
          break
        case TokenKind.Integer:
          atLineStart = false
          integer(token)
          break
        default:
          break
      }
    } while ((token = token.next))
  }

  closeLine()

  if (diagnostics.length) return { ok: false, diagnostics }
  return { ok: true, stream: { ...tokens, events } }

  // Validate the first content node on a line.
  function startContent() {
    const frame = indent()
    if (atLineStart) {
      atLineStart = false
      if (frame.ownLine !== false) frame.ownLine = true
    } else if (!frame.used) {
      frame.ownLine = false
    }
    frame.used = true
  }

  function space(token: Token) {
    while (top()?.kind === Context.Name) {
      events.push({ kind: EventKind.CloseName })
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
        if (indents.length === 1)
          fail(
            'invalid-indentation',
            token,
            'indent one level deeper than the parent, not more',
          )
        depth = lastDepth + 1
      } else if (depth < frame.depth) {
        depth = frame.depth + 1
      }

      let diff = depth - frame.depth
      while (diff-- > 0) {
        contexts.push({ kind: Context.Indent })
        events.push({ kind: EventKind.OpenIndent })
      }
      lastDepth = depth
    } else if (token.previous?.kind === TokenKind.Integer) {
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
    events.push({ kind: EventKind.OpenText, token })
    indent().ownLine = endsLineWithNewline(token)
  }

  function endsLineWithNewline(token: Token): boolean {
    if (token.next?.kind === TokenKind.Chunk) {
      return Boolean(token.next.text.match(/^\s*\n$/))
    }
    return false
  }

  function closeText(token: Token) {
    events.push({ kind: EventKind.CloseText, token })
    pop()
    popIndent()
  }

  function decimal(token: Token) {
    startContent()
    events.push({
      kind: EventKind.Decimal,
      token,
      value: parseFloat(token.text),
    })
  }

  function radix(token: Token) {
    startContent()
    const found = token.text.match(/^0([xXbBoO])([0-9a-fA-F]+)/)
    if (found) {
      const base = found[1]!.toLowerCase()
      const radixValue = base === 'b' ? 2 : base === 'o' ? 8 : 16
      events.push({
        kind: EventKind.Radix,
        token,
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
    if (frame.ownLine) {
      token.text = token.text.slice(frame.depth * 2).trimEnd()
    }

    const last = events[events.length - 1]
    // merge consecutive chunks inside a multiline text to keep things clean
    if (last?.kind === EventKind.Chunk && frame.ownLine) {
      if (token.text) {
        last.token.text = last.token.text
          ? last.token.text.endsWith('\n')
            ? `${last.token.text}${token.text}`
            : `${last.token.text} ${token.text}`
          : token.text
      } else if (token.next?.kind === TokenKind.Chunk) {
        last.token.text += '\n\n'
      }
    } else {
      events.push({ kind: EventKind.Chunk, token })
    }
  }

  function integer(token: Token) {
    startContent()
    events.push({
      kind: EventKind.Integer,
      token,
      value: parseInt(token.text, 10),
    })
  }

  function comma() {
    if (top()?.kind === Context.Name) {
      pop()
      events.push({ kind: EventKind.CloseName })
      pop()
      events.push({ kind: EventKind.CloseGroup })
    }
  }

  function name(token: Token) {
    openName(token)

    if (token.text.includes('/')) {
      const followsClose = token.previous?.kind === TokenKind.CloseBrace
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

    events.push({ kind: EventKind.Chunk, token })
  }

  function openName(token: Token) {
    const previousKind = token.previous?.kind
    if (
      previousKind === undefined ||
      previousKind === TokenKind.Newline ||
      previousKind === TokenKind.Comma ||
      previousKind === TokenKind.OpenBrace ||
      previousKind === TokenKind.Space
    ) {
      events.push({ kind: EventKind.OpenGroup })
      push({ kind: Context.Group })
      startContent()
      events.push({ kind: EventKind.OpenName })
      push({ kind: Context.Name })
    }
  }

  function openInterpolation(token: Token) {
    const previousKind = token.previous?.kind
    if (
      previousKind === undefined ||
      previousKind === TokenKind.Newline ||
      previousKind === TokenKind.Space
    ) {
      push({ kind: Context.Group })
      events.push({ kind: EventKind.OpenGroup })
      push({ kind: Context.Name })
      events.push({ kind: EventKind.OpenName })
    }
    push({ kind: Context.Interpolation, token })
    events.push({
      kind: EventKind.OpenInterpolation,
      token,
      depth: token.text.length,
    })
    pushIndent(1)
  }

  // Close a parenthesis. Parentheses live on one line.
  function closeParen() {
    walk: while (true) {
      switch (top()?.kind) {
        case Context.Indent:
          events.push({ kind: EventKind.CloseIndent })
          pop()
          break
        case Context.Group:
          events.push({ kind: EventKind.CloseGroup })
          pop()
          break
        case Context.Name:
          events.push({ kind: EventKind.CloseName })
          pop()
          break
        default:
          break walk
      }
    }
  }

  function closeInterpolation() {
    walk: while (true) {
      const frame = top()
      switch (frame?.kind) {
        case Context.Name:
          events.push({ kind: EventKind.CloseName })
          pop()
          break
        case Context.Indent:
          events.push({ kind: EventKind.CloseIndent })
          pop()
          break
        case Context.Group:
          events.push({ kind: EventKind.CloseGroup })
          pop()
          break
        case Context.Interpolation:
          events.push({
            kind: EventKind.CloseInterpolation,
            token: frame.token!,
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
          events.push({ kind: EventKind.CloseGroup })
          pop()
          break
        case Context.Indent:
          events.push({ kind: EventKind.CloseIndent })
          pop()
          break
        case Context.Name:
          events.push({ kind: EventKind.CloseName })
          pop()
          break
        case Context.Root:
          break walk
        default:
          break walk
      }
    }
  }
}
