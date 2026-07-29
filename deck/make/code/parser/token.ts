// The lexer. Source text to a linked list of tokens. Table-driven: a set of matchers per lexer mode, where the
// mode stack (default, text, interpolation, name) selects which matchers can fire next. Browser-safe.

import type {
  Diagnostic,
  Span,
} from '@cluesurf/make/code/parser/diagnostic'
import { diagnose } from '@cluesurf/make/code/parser/diagnostic'

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
  lines: string[]
  head?: Token
}

export type TokenResult =
  | { ok: true; tokens: TokenList }
  | { ok: false; diagnostics: Diagnostic[] }

// Which token kinds may match in each mode, in priority order.
const INTERPOLATION_MATCHERS: TokenKind[] = [
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

const TEXT_MATCHERS: TokenKind[] = [
  TokenKind.OpenBrace,
  TokenKind.CloseAngle,
  TokenKind.Chunk,
]

const NAME_MATCHERS: TokenKind[] = [TokenKind.OpenBrace, TokenKind.Name]

const DEFAULT_MATCHERS: TokenKind[] = [
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

const MODE_MATCHERS: Record<LexMode, TokenKind[]> = {
  [LexMode.Default]: DEFAULT_MATCHERS,
  [LexMode.Text]: TEXT_MATCHERS,
  [LexMode.Interpolation]: INTERPOLATION_MATCHERS,
  [LexMode.Name]: NAME_MATCHERS,
}

// The matchers. Lenient on purpose so later passes can raise good errors rather than failing to match.
// Patterns are STICKY (`y`): they match only at `regex.lastIndex`, which the
// tokenizer sets to the current cursor. This lets the lexer advance a cursor
// over each line instead of repeatedly slicing it (which was O(line^2) on long
// lines - a real cost for big text literals / large files). `^` is dropped
// because `y` already anchors at the cursor; with `y`, `^` would wrongly only
// match offset 0.
const PATTERN: Record<TokenKind, RegExp> = {
  [TokenKind.CloseBrace]: /\}+/y,
  [TokenKind.CloseParen]: /\)/y,
  [TokenKind.CloseAngle]: />/y,
  [TokenKind.Comma]: /, */y,
  [TokenKind.Comment]: /#(?: +[^\n]+)?/y,
  [TokenKind.Decimal]: /-?\d+\.\d+/y,
  [TokenKind.Radix]: /0[xXbBoOuU]\w+/y,
  [TokenKind.Newline]: /\n/y,
  // a `{` opens an interpolation ONLY when an identifier follows (`{name}`); otherwise it is a literal brace. This lets
  // a text string carry JSON (`<{"a":1}>`) or a regex quantifier (`<[0-9]{3}>`) without escaping, while `{name}`
  // template / string interpolation still works.
  [TokenKind.OpenBrace]: /\{+(?=[a-zA-Z_])/y,
  [TokenKind.OpenParen]: /\(/y,
  [TokenKind.OpenAngle]: /</y,
  [TokenKind.Space]: / +/y,
  [TokenKind.Name]: /[@~$%^&*'":.a-z0-9A-Z_\-?/]+/y,
  // a bare run of digits is an Integer, BUT digits followed by a hyphen and a letter (`24-cell`) is a kebab IDENTIFIER,
  // not a number, so the Integer matcher declines there and the Name matcher claims the whole `24-cell`. A pure number
  // (`24`, `24-3`) is unaffected.
  [TokenKind.Integer]: /-?\d+(?=\b)(?!-[a-zA-Z])/y,
  // a chunk runs over literal text, including a `{` that does not open an interpolation (not followed by an
  // identifier) and any `}`; it stops at `>` (close), `\` (escape), or an interpolation-opening `{`. Escapes cover
  // the delimiters (`\<` `\>` `\{` `\}`) and the standard characters (`\n` `\r` `\t` `\\`); the mill unescapes.
  // a backslash that does not introduce a known escape is a LITERAL backslash, so a Windows path (`text <\Temp>`) or
  // any other stray `\` can be written without doubling it. Without this the chunk matcher stops dead at the `\` and
  // no matcher can consume it, which surfaces as a structure error rather than anything about the backslash.
  [TokenKind.Chunk]:
    /(?:\\[<>{}nrt\\]|\\(?![<>{}nrt\\])|\{+(?![a-zA-Z_])|[^>{\\])+/y,
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

  const braceStack: string[] = []
  const modeStack: LexMode[] = [LexMode.Default]
  // running `<` minus `>` balance for each open text literal, so a nested `>` (closing a generic like `Hmac<Sha256>`,
  // not the literal) stays content. One entry per Text frame on the mode stack, so nested texts do not interfere.
  const textDepthStack: number[] = []

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

  for (const rawLine of tokens.lines) {
    const lineText = `${rawLine}\n`

    // a cursor over the line, advanced in place (no slicing): O(line) total
    let pos = 0

    while (pos < lineText.length) {
      const mode = modeStack[modeStack.length - 1] ?? LexMode.Default

      // inside a text literal, `\<` and `\>` are the escaped angles: emit the bare angle as content and do NOT touch
      // the depth balance, so an unbalanced one can be written at all. Depth-balancing alone cannot express `=>` or a
      // lone `<` in native source, because those never pair up. The backslash is consumed, so `\>` yields `>`.
      if (
        mode === LexMode.Text &&
        lineText.startsWith('\\', pos) &&
        (lineText.startsWith('<', pos + 1) ||
          lineText.startsWith('>', pos + 1))
      ) {
        const token: Token = {
          kind: TokenKind.Chunk,
          span: {
            start: { line, column },
            end: { line, column: column + 2 },
          },
          text: lineText[pos + 1]!,
        }

        append(token)
        previous = token
        pos += 2
        column += 2
        continue
      }

      // inside a text literal with an unclosed `<`, the next `>` closes that nested bracket, not the literal: emit it as
      // a literal chunk and rebalance, so `text <Hmac<Sha256>>` keeps the generic and ends only at the final `>`.
      if (
        mode === LexMode.Text &&
        lineText.startsWith('>', pos) &&
        (textDepthStack[textDepthStack.length - 1] ?? 0) > 0
      ) {
        const token: Token = {
          kind: TokenKind.Chunk,
          span: {
            start: { line, column },
            end: { line, column: column + 1 },
          },
          text: '>',
        }

        append(token)
        previous = token
        pos += 1
        column += 1
        textDepthStack[textDepthStack.length - 1]! -= 1
        continue
      }

      let matched = false

      for (const kind of MODE_MATCHERS[mode]) {
        const pattern = PATTERN[kind]
        // sticky match anchored at the cursor
        pattern.lastIndex = pos

        const found = pattern.exec(lineText)

        if (!found) {
          continue
        }

        matched = true

        let size = found[0].length
        let text = lineText.slice(pos, pos + size)

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

        pos += size
        column += size

        if (kind === TokenKind.OpenBrace) {
          braceStack.push(text)
        } else if (kind === TokenKind.CloseBrace) {
          braceStack.pop()
        }

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
            textDepthStack.push(0)
            break
          case TokenKind.CloseAngle:
            modeStack.pop()
            textDepthStack.pop()
            break
          case TokenKind.Chunk:
            // a chunk in a text literal may carry unescaped `<` (a generic / less-than); each deepens the bracket
            // balance so its matching `>` is treated as content rather than the literal's terminator.
            if (mode === LexMode.Text && textDepthStack.length > 0) {
              textDepthStack[textDepthStack.length - 1]! += (
                text.match(/(?<!\\)</g) ?? []
              ).length
            }

            break
          default:
            break
        }

        break
      }

      // no matcher consumed any input. If we never advance we loop
      // forever, so always stop here - even with no previous token (an
      // unlexable first character, e.g. a leading tab, lands here). Point
      // the error at the previous token when there is one, otherwise at
      // the current position.
      if (!matched) {
        return {
          ok: false,
          diagnostics: [
            diagnose('syntax-error', {
              file: source.file,
              span: previous
                ? previous.span
                : {
                    start: { line, column },
                    end: { line, column: column + 1 },
                  },
            }),
          ],
        }
      }
    }

    // leftover unconsumed input on the line (the cursor did not reach the end)
    if (pos < lineText.length) {
      return {
        ok: false,
        diagnostics: [
          diagnose('syntax-error', {
            file: source.file,
            span: previous
              ? previous.span
              : {
                  start: { line, column },
                  end: { line, column: column + 1 },
                },
          }),
        ],
      }
    }
  }

  return { ok: true, tokens }
}
