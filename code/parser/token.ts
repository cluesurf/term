// The lexer. Source text to a linked list of tokens. Table-driven: a set of matchers per lexer mode, where the
// mode stack (default, text, interpolation, name) selects which matchers can fire next. Browser-safe.

import type { Diagnostic, Span } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'

export enum LexMode {
  Default = 'default',
  Text = 'text',
  Interpolation = 'interpolation',
  Name = 'name',
}

export enum TokenKind {
  CloseBrace = 'close-brace', // }}
  CloseParen = 'close-paren', // )
  CloseAngle = 'close-angle', // > end of text
  Comma = 'comma',
  Comment = 'comment',
  Decimal = 'decimal', // 3.14
  Radix = 'radix', // 0x.., 0b.., 0o..
  Newline = 'newline',
  OpenBrace = 'open-brace', // {{
  OpenParen = 'open-paren', // (
  OpenAngle = 'open-angle', // < start of text
  Space = 'space',
  Name = 'name', // a term or path
  Integer = 'integer',
  Chunk = 'chunk', // a literal text chunk inside < >
}

export type Token = {
  kind: TokenKind
  span: Span
  text: string
  previous?: Token
  next?: Token
}

export type TokenList = {
  file: string
  text: string
  lines: Array<string>
  head?: Token
}

export type TokenResult =
  | { ok: true; tokens: TokenList }
  | { ok: false; diagnostics: Array<Diagnostic> }

// Which token kinds may match in each mode, in priority order.
const INTERPOLATION_MATCHERS: Array<TokenKind> = [
  TokenKind.CloseBrace,
  TokenKind.CloseParen,
  TokenKind.CloseAngle,
  TokenKind.Comma,
  TokenKind.Comment,
  TokenKind.Decimal,
  TokenKind.Radix,
  TokenKind.Newline,
  TokenKind.OpenBrace,
  TokenKind.OpenParen,
  TokenKind.OpenAngle,
  TokenKind.Name,
  TokenKind.Integer,
  TokenKind.Space,
]

const TEXT_MATCHERS: Array<TokenKind> = [
  TokenKind.OpenBrace,
  TokenKind.CloseAngle,
  TokenKind.Chunk,
]

const NAME_MATCHERS: Array<TokenKind> = [
  TokenKind.OpenBrace,
  TokenKind.Name,
]

const DEFAULT_MATCHERS: Array<TokenKind> = [
  TokenKind.CloseBrace,
  TokenKind.CloseParen,
  TokenKind.CloseAngle,
  TokenKind.Comma,
  TokenKind.Comment,
  TokenKind.Decimal,
  TokenKind.Radix,
  TokenKind.Newline,
  TokenKind.OpenBrace,
  TokenKind.OpenParen,
  TokenKind.OpenAngle,
  TokenKind.Integer,
  TokenKind.Space,
  TokenKind.Name,
]

const MODE_MATCHERS: Record<LexMode, Array<TokenKind>> = {
  [LexMode.Default]: DEFAULT_MATCHERS,
  [LexMode.Text]: TEXT_MATCHERS,
  [LexMode.Interpolation]: INTERPOLATION_MATCHERS,
  [LexMode.Name]: NAME_MATCHERS,
}

// The matchers. Lenient on purpose so later passes can raise good errors rather than failing to match.
const PATTERN: Record<TokenKind, RegExp> = {
  [TokenKind.CloseBrace]: /^\}+/,
  [TokenKind.CloseParen]: /^\)/,
  [TokenKind.CloseAngle]: /^>/,
  [TokenKind.Comma]: /^, */,
  [TokenKind.Comment]: /^# +[^\n]+/,
  [TokenKind.Decimal]: /^-?\d+\.\d+/,
  [TokenKind.Radix]: /^0[xXbBoO]\w+/,
  [TokenKind.Newline]: /^\n/,
  // a `{` opens an interpolation ONLY when an identifier follows (`{name}`); otherwise it is a literal brace. This lets
  // a text string carry JSON (`<{"a":1}>`) or a regex quantifier (`<[0-9]{3}>`) without escaping, while `{name}`
  // template / string interpolation still works.
  [TokenKind.OpenBrace]: /^\{+(?=[a-zA-Z_])/,
  [TokenKind.OpenParen]: /^\(/,
  [TokenKind.OpenAngle]: /^</,
  [TokenKind.Space]: /^ +/,
  [TokenKind.Name]: /^[@~$%^&*'":.a-z0-9A-Z_\-?/]+/,
  [TokenKind.Integer]: /^-?\d+(?=\b)/,
  // a chunk runs over literal text, including a `{` that does not open an interpolation (not followed by an
  // identifier) and any `}`; it stops at `>` (close), `\` (escape), or an interpolation-opening `{`.
  [TokenKind.Chunk]: /^(?:\\[<>{}]|\{+(?![a-zA-Z_])|[^>{\\])+/,
}

export function tokenize(source: {
  file: string
  text: string
}): TokenResult {
  const tokens: TokenList = {
    file: source.file,
    text: source.text,
    lines: source.text.split('\n'),
  }

  const braceStack: Array<string> = []
  const modeStack: Array<LexMode> = [LexMode.Default]

  let line = 0
  let column = 0
  let previous: Token | undefined

  function append(token: Token) {
    if (!tokens.head) {
      tokens.head = token
    } else if (previous) {
      token.previous = previous
      previous.next = token
    }
  }

  for (let lineText of tokens.lines) {
    lineText = `${lineText}\n`

    while (lineText) {
      const mode = modeStack[modeStack.length - 1] ?? LexMode.Default
      let matched = false

      for (const kind of MODE_MATCHERS[mode]) {
        const found = lineText.match(PATTERN[kind])
        if (!found) continue
        matched = true

        let size = found[0].length
        let text = lineText.slice(0, size)

        // a closing }} only consumes as many braces as the matching opener pushed
        if (kind === TokenKind.CloseBrace) {
          const open = braceStack[braceStack.length - 1]
          if (open) {
            size = open.length
            text = text.slice(0, open.length)
          }
        }

        const token: Token = {
          kind,
          span: {
            start: { line, column },
            end: { line, column: column + size },
          },
          text,
        }
        append(token)
        previous = token

        lineText = lineText.slice(size)
        column += size

        if (kind === TokenKind.OpenBrace) braceStack.push(text)
        else if (kind === TokenKind.CloseBrace) braceStack.pop()

        switch (kind) {
          case TokenKind.Newline:
            line++
            column = 0
            break
          case TokenKind.OpenBrace:
            modeStack.push(LexMode.Interpolation)
            break
          case TokenKind.CloseBrace:
            modeStack.pop()
            break
          case TokenKind.OpenAngle:
            modeStack.push(LexMode.Text)
            break
          case TokenKind.CloseAngle:
            modeStack.pop()
            break
          default:
            break
        }
        break
      }

      if (!matched && previous) {
        return {
          ok: false,
          diagnostics: [
            diagnose('syntax-error', {
              file: source.file,
              span: previous.span,
            }),
          ],
        }
      }
    }

    if (lineText.length && previous) {
      return {
        ok: false,
        diagnostics: [
          diagnose('syntax-error', {
            file: source.file,
            span: previous.span,
          }),
        ],
      }
    }
  }

  return { ok: true, tokens }
}
