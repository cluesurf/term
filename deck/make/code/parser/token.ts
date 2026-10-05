// The lexer. Source text to a linked list of tokens. Table-driven: a set of matchers per lexer mode, where the
// mode stack (default, text, interpolation, name) selects which matchers can fire next. Browser-safe.

import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

export enum LexMode {
  Default = 'default',
  Text = 'text',
  Interpolation = 'interpolation',
  Name = 'name',
}

export type TokenKind =
  | 'close-brace' // }}
  | 'close-paren' // )
  | 'close-angle' // > end of text
  | 'comma'
  | 'comment'
  | 'decimal' // 3.14
  | 'radix' // 0x.., 0b.., 0o..
  | 'newline'
  | 'open-brace' // {{
  | 'open-paren' // (
  | 'open-angle' // < start of text
  | 'space'
  | 'name' // a term or path
  | 'integer'
  | 'chunk' // a literal text chunk inside < >

export type Token = {
  kind: TokenKind
  span: Span
  text: string
}

// the tokens in source order. A reader looks one step either way by index, so a token holds no link to its
// neighbors (it was a doubly linked list, which a Term record cannot be)
export type TokenList = {
  file: string
  text: string
  lines: string[]
  list: Token[]
}

// the tokens, and every diagnostic found on the way: the text lexed with no mistake when there are none. The tokens are
// kept either way, as far as the lexer could read them
export type TokenResult = { tokens: TokenList; diagnostics: Diagnostic[] }

// Which token kinds may match in each mode, in priority order.
const INTERPOLATION_MATCHERS: TokenKind[] = [
  'close-brace',
  'close-paren',
  'close-angle',
  'comma',
  'comment',
  'decimal',
  'radix',
  'newline',
  'open-brace',
  'open-paren',
  'open-angle',
  // Integer before Name, as on a line: the Name pattern takes digits too, so with Name first a number inside braces
  // was a name, and `<sum {add-two(2, 3)}>` failed with `the name "2" is not defined` (guides: language/syntax,
  // values, collections, 2026-10-04). A word that starts with a letter is still a Name, the Integer pattern failing
  // on its first character
  'integer',
  'name',
  'space',
]

const TEXT_MATCHERS: TokenKind[] = [
  'open-brace',
  'close-angle',
  'chunk',
]

const NAME_MATCHERS: TokenKind[] = ['open-brace', 'name']

const DEFAULT_MATCHERS: TokenKind[] = [
  'close-brace',
  'close-paren',
  'close-angle',
  'comma',
  'comment',
  'decimal',
  'radix',
  'newline',
  'open-brace',
  'open-paren',
  'open-angle',
  'integer',
  'space',
  'name',
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
  ['close-brace']: /\}+/y,
  ['close-paren']: /\)/y,
  ['close-angle']: />/y,
  ['comma']: /, */y,
  ['comment']: /#(?: +[^\n]+)?/y,
  ['decimal']: /-?\d+\.\d+/y,
  ['radix']: /0[xXbBoOuU]\w+/y,
  ['newline']: /\n/y,
  // a `{` opens an interpolation ONLY when an identifier follows (`{name}`); otherwise it is a literal brace. This lets
  // a text string carry JSON (`<{"a":1}>`) or a regex quantifier (`<[0-9]{3}>`) without escaping, while `{name}`
  // template / string interpolation still works.
  // A DOUBLE brace may be followed by whitespace, including a newline, before its content: `{{ foo }}` and a
  // `{{` that opens at the end of a line are interpolations holding a tree, which is what
  // test/parser/file/text-multiline.tree and sink.tree are written in. A SINGLE `{` still has to be followed
  // immediately by a letter, because that is what keeps an embedded JS or Rust block literal — `text <... { if
  // (sc === 0) ... }>` in decimal.tree would otherwise open an interpolation. Only the braces are captured, so
  // the interpolation's depth is still the length of the match.
  ['open-brace']: /\{+(?=\s*(?:[a-zA-Z_]|$))/y,
  ['open-paren']: /\(/y,
  ['open-angle']: /</y,
  ['space']: / +/y,
  // A bare name may carry ESCAPED BRACES. `{` normally opens an interpolation, so a
  // glob written bare (`@/book/**/\{code,view\}/**/*.tree`) escapes them. The escaped
  // group is consumed WHOLE, commas included, since a comma would otherwise end the
  // token and split the pattern in two. `\{` / `\}` on their own are also literal.
  // The reader unescapes, so the value comes back as `{code,view}`.
  ['name']:
    /(?:\\\{[^\\]*\\\}|\\[{}<>\\]|[@~$%^&*'":.a-z0-9A-Z_\-?/])+/y,
  // a bare run of digits is an Integer, BUT digits followed by a hyphen and a letter (`24-cell`) is a kebab IDENTIFIER,
  // not a number, so the Integer matcher declines there and the Name matcher claims the whole `24-cell`. A pure number
  // (`24`, `24-3`) is unaffected.
  // a bare run of digits, OR a run written with THOUSAND SEPARATORS (`2,440,588`). The separated form requires exactly
  // three digits after each comma and no space, so an ordinary argument list (`take a, 3`) still splits on its comma:
  // only `1,234` binds as one number, never `1, 234`. The separated alternative is tried first, since the plain one
  // would otherwise match just the leading `2`.
  ['integer']:
    /-?\d{1,3}(?:,\d{3})+(?![\d,])|-?\d+(?=\b)(?!-[a-zA-Z])/y,
  // a chunk runs over literal text, including a `{` that does not open an interpolation (not followed by an
  // identifier) and any `}`; it stops at `>` (close), `\` (escape), or an interpolation-opening `{`. Escapes cover
  // the delimiters (`\<` `\>` `\{` `\}`) and the standard characters (`\n` `\r` `\t` `\\`); the mill unescapes.
  // a backslash that does not introduce a known escape is a LITERAL backslash, so a Windows path (`text <\Temp>`) or
  // any other stray `\` can be written without doubling it. Without this the chunk matcher stops dead at the `\` and
  // no matcher can consume it, which surfaces as a structure error rather than anything about the backslash.
  // a run of braces followed by a letter opens an interpolation whole (`{x}` is depth one, `{{x}}` depth two, the
  // runtime interpolation), so the chunk matcher stops before a brace run that a letter follows
  ['chunk']:
    // `e` alongside `nrt`: `\e` is the escape character (0x1B), which is what every ANSI color sequence opens
    // with and the one thing a Term program needed to write terminal output without an npm package.
    /(?:\\[<>{}nrte\\]|\\(?![<>{}nrte\\])|\{+(?!\s*(?:[a-zA-Z_{]|$))|[^>{\\])+/y,
}

// a raw literal's content as the chunk an ordinary literal would carry for the same text: the mill unescapes `\\`,
// `\{` and `\}`, so those are escaped, and angles stay bare, as the lexer leaves them in any chunk
export function rawChunk(content: string): string {
  return content.replace(/[\\{}]/g, c => `\\${c}`)
}

// the content a raw literal was written with, from its chunk (the inverse of `rawChunk`)
export function rawContent(chunk: string): string {
  return chunk.replace(/\\([\\{}])/g, '$1')
}

/**
 * Diagnostics found while lexing, rather than the first one.
 *
 * A file with three mistakes should report three. Returning on the first
 * means a person fixes one, runs again, and finds the next: three round trips
 * for one sitting's work. The lexer knows how to carry on past every error it
 * can raise, so it does.
 */
export function tokenize(source: {
  file: string
  text: string
}): TokenResult {
  const tokens: TokenList = {
    file: source.file,
    text: source.text,
    lines: source.text.split('\n'),
    list: [],
  }

  const braceStack: string[] = []
  // EVERY diagnostic, not the first. A file with three mistakes reports
  // three: returning on the first means a person fixes one, runs again, and
  // meets the next, which is three round trips for one sitting's work.
  const found: Diagnostic[] = []

  const modeStack: LexMode[] = [LexMode.Default]
  // where each currently-open text literal started. Only used to report one
  // that never closed, which otherwise swallows the rest of the file.
  const textOpenStack: Array<{ line: number; column: number }> = []
  // running `<` minus `>` balance for each open text literal, so a nested `>` (closing a generic like `Hmac<Sha256>`,
  // not the literal) stays content. One entry per Text frame on the mode stack, so nested texts do not interfere.
  const textDepthStack: number[] = []

  let line = 0
  let column = 0
  let previous: Token | undefined

  function append(token: Token) {
    tokens.list.push(token)
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
          kind: 'chunk',
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

      // A RAW TEXT LITERAL, `<<...>>`, wherever a text literal may open: its content is read exactly as written, up to
      // the `>>` that ends the first run of `>` on the same line, with no interpolation and no escape, so a pattern reads as its engine reads it
      // (`<<\p{Lu}(?<=x)>>`). It reaches every later stage as an ordinary literal: the open token carries `<<`, which
      // the tree keeps (`raw`) so a printer writes it back the same way, and the one chunk is escaped so that the
      // mill's unescaping gives the content back verbatim. Text holding `>>`, or more than one line, is an ordinary
      // literal with its angles escaped. Until 2026-10-04 `<<x>>` was a literal holding the nested text `<x>`, which is
      // now written `<\<x\>>` (note/term/stdlib/regex-engine.md, "Writing a pattern in a `.tree` file").
      if ((mode === LexMode.Default || mode === LexMode.Interpolation) && lineText.startsWith('<<', pos)) {
        // the LAST two of the first run of `>`, so content may end in `>` (`<<<.+?>>>` holds `<.+?>`) and two raw
        // literals on one line still close apart (`f(<<a>>, <<b>>)`)
        let end = lineText.indexOf('>>', pos + 2)

        while (end >= 0 && lineText[end + 2] === '>') {
          end++
        }

        if (end < 0) {
          found.push(
            diagnose('syntax-error', {
              file: source.file,
              span: { start: { line, column }, end: { line, column: column + 2 } },
              message: 'a raw text literal `<<...>>` must end with `>>` on the same line',
              hint: 'for text holding `>>` or spanning lines, write an ordinary literal and escape its angles: `<\\<x\\>>` is the text `<x>`',
            }),
          )

          // the rest of the line cannot be read as anything sensible: skip to its newline, which still lexes, so the
          // next line is the resync point and this one reports once
          column += lineText.length - 1 - pos
          pos = lineText.length - 1
          continue
        }

        const content = lineText.slice(pos + 2, end)
        const tokensOf: Token[] = [
          { kind: 'open-angle', span: { start: { line, column }, end: { line, column: column + 2 } }, text: '<<' },
          ...(content
            ? [
                {
                  kind: 'chunk' as const,
                  span: { start: { line, column: column + 2 }, end: { line, column: column + 2 + content.length } },
                  text: rawChunk(content),
                },
              ]
            : []),
          {
            kind: 'close-angle',
            span: { start: { line, column: column + 2 + content.length }, end: { line, column: column + 4 + content.length } },
            text: '>>',
          },
        ]

        for (const token of tokensOf) {
          append(token)
          previous = token
        }

        pos = end + 2
        column += 4 + content.length
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
          kind: 'chunk',
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

        const hit = pattern.exec(lineText)

        if (!hit) {
          continue
        }

        matched = true

        let size = hit[0].length
        let text = lineText.slice(pos, pos + size)

        // a closing }} only consumes as many braces as the matching opener pushed
        if (kind === 'close-brace') {
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

        if (kind === 'open-brace') {
          braceStack.push(text)
        } else if (kind === 'close-brace') {
          braceStack.pop()
        }

        switch (kind) {
          case 'newline':
            line++
            column = 0
            break
          case 'open-brace':
            modeStack.push(LexMode.Interpolation)
            break
          case 'close-brace':
            modeStack.pop()
            break
          case 'open-angle':
            modeStack.push(LexMode.Text)
            textDepthStack.push(0)
            // where this literal opened, so an unclosed one can point at it
            textOpenStack.push({ line, column })
            break
          case 'close-angle':
            modeStack.pop()
            textDepthStack.pop()
            textOpenStack.pop()
            break
          // A comma is ORDINARY inside an interpolation. `{...}` and `{{...}}` hold a whole tree, not one name:
          // `{foo bar, baz}` and `{foo(bar,baz(bing boom))}` are both trees, read by the same rules as anywhere
          // else (a space nests, a comma pops one level). Space nesting already worked; the comma was refused,
          // which is what made `values.tree`'s `b{x y 123, 123}/c` and `index.tree`'s
          // `{another(a/b/c, 1, foo bar baz)}` unparseable even though both are fixtures of the grammar.
          //
          // The case that refusal was protecting against is a glob whose braces were never escaped
          // (`@/book/**/{code,view}/**`). That is still handled, one level up: an interpolation only OPENS on a
          // `{` followed by a name, so `{"a":1}` and `{ ... }` stay literal text, and a real `{code,view}` in a
          // path is written `\{code,view\}` as it always was. Checked across the tree: the only unescaped
          // `{name,` left is inside a `#` comment.
          case 'chunk':
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
        // `read items/{0}`: a brace opens an interpolation only before a letter, so a digit inside one is the one
        // mistake the grammar cannot lex at all. Name the spelling it wanted, and skip the whole `{0}` so the rest of
        // the line is still read.
        const bracedIndex = /\{(\d+)\}/y
        bracedIndex.lastIndex = pos
        const literalIndex = bracedIndex.exec(lineText)

        if (literalIndex) {
          found.push(
            diagnose('syntax-error', {
              file: source.file,
              span: {
                start: { line, column },
                end: { line, column: column + literalIndex[0].length },
              },
              message: `a literal index is a plain segment: write /${literalIndex[1]}, not /{${literalIndex[1]}}`,
              hint: 'braces evaluate a name, `read x/{key}`; a number is a segment of its own',
            }),
          )

          pos += literalIndex[0].length
          column += literalIndex[0].length
          continue
        }

        // RECORD IT AND SKIP ONE CHARACTER. Returning here abandons the rest
        // of the file, so a second mistake three lines down is never seen.
        // Advancing by one guarantees progress, which is what the loop needs,
        // and lets the remaining lines be lexed and checked.
        found.push(
          diagnose('syntax-error', {
            file: source.file,
            span: previous
              ? previous.span
              : {
                  start: { line, column },
                  end: { line, column: column + 1 },
                },
          }),
        )

        pos += 1
        column += 1
        continue
      }
    }

    // leftover unconsumed input on the line (the cursor did not reach the end)
    if (pos < lineText.length) {
      // The rest of THIS line is not lexable, so the next line is the resync
      // point. A line is the natural unit to recover at here, because the
      // structure pass keys nesting off line indentation anyway.
      found.push(
        diagnose('syntax-error', {
          file: source.file,
          span: previous
            ? previous.span
            : {
                start: { line, column },
                end: { line, column: column + 1 },
              },
        }),
      )
    }
  }

  // A TEXT LITERAL LEFT OPEN AT THE END OF THE FILE IS AN ERROR.
  //
  // Inside a literal, `<` and `>` balance, so that a generic like `Hmac<Sha256>`
  // can be written as content. The cost is that ONE unescaped `<` -- a `s < 60`
  // in a native body, say -- opens a bracket that never closes, and the literal
  // eats the rest of the file in silence.
  //
  // What that looks like is every later name in the file being undefined, and
  // the build reporting missing names in a dozen OTHER files that imported
  // them, with nothing pointing at the line that actually did it. Reporting it
  // here, at the `<` that opened it, is the difference between a minute and an
  // afternoon. Write `\<` for a literal one.
  if (textOpenStack.length > 0) {
    const at = textOpenStack[textOpenStack.length - 1]!

    found.push(
      diagnose('syntax-error', {
          file: source.file,
          hint: 'this text literal is never closed, so it swallows the rest of the file. Inside a literal `<` and `>` balance, so an unescaped one opens a bracket that never closes. Write `\\<` and `\\>` for literal angles',
        span: {
          start: { line: at.line, column: at.column },
          end: { line: at.line, column: at.column + 1 },
        },
      }),
    )
  }

  return { tokens, diagnostics: found }
}
