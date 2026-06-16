// The lexer. Text to a linked list of leaf tokens. Table-driven: a regex set per lexer state, where the state
// stack (base, nick, text, term) selects which token set can match next. Faithful port of @cluesurf/tree's
// leaf pass, with external dependencies dropped and errors routed through the diagnostic system.

import type { Band, Diagnostic } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'

export enum LeafState {
  Base = 'base',
  Text = 'text',
  Nick = 'nick',
  Term = 'term',
}

export enum LeafName {
  FallNick = 'leaf-fall-nick',
  FallHold = 'leaf-fall-hold',
  FallText = 'leaf-fall-text',
  Link = 'leaf-link',
  Note = 'leaf-note',
  Comb = 'leaf-comb',
  Code = 'leaf-code',
  RiseNick = 'leaf-rise-nick',
  RiseHold = 'leaf-rise-hold',
  RiseText = 'leaf-rise-text',
  Cord = 'leaf-cord',
  Size = 'leaf-size',
  Slot = 'leaf-slot',
  SlotLine = 'leaf-slot-line',
  Knit = 'leaf-knit',
}

export type Leaf = {
  form: LeafName
  band: Band
  text: string
  back?: Leaf
  head?: Leaf
}

export type LeafCast = {
  file: string
  text: string
  lineText: Array<string>
  head?: Leaf
}

export type LeafResult =
  | { ok: true; cast: LeafCast }
  | { ok: false; diagnostics: Array<Diagnostic> }

// Which token kinds may match in each lexer state, in priority order.
const NICK_TEST_LIST: Array<LeafName> = [
  LeafName.FallNick,
  LeafName.FallHold,
  LeafName.FallText,
  LeafName.Link,
  LeafName.Note,
  LeafName.Comb,
  LeafName.Code,
  LeafName.SlotLine,
  LeafName.RiseNick,
  LeafName.RiseHold,
  LeafName.RiseText,
  LeafName.Knit,
  LeafName.Size,
  LeafName.Slot,
]

const TEXT_TEST_LIST: Array<LeafName> = [LeafName.RiseNick, LeafName.FallText, LeafName.Cord]

const TERM_TEST_LIST: Array<LeafName> = [LeafName.RiseNick, LeafName.Knit]

const BASE_TEST_LIST: Array<LeafName> = [
  LeafName.FallNick,
  LeafName.FallHold,
  LeafName.FallText,
  LeafName.Link,
  LeafName.Note,
  LeafName.Comb,
  LeafName.Code,
  LeafName.SlotLine,
  LeafName.RiseNick,
  LeafName.RiseHold,
  LeafName.RiseText,
  LeafName.Size,
  LeafName.Slot,
  LeafName.Knit,
]

const STATE_TESTS: Record<LeafState, Array<LeafName>> = {
  [LeafState.Base]: BASE_TEST_LIST,
  [LeafState.Text]: TEXT_TEST_LIST,
  [LeafState.Nick]: NICK_TEST_LIST,
  [LeafState.Term]: TERM_TEST_LIST,
}

// The matchers. Lenient on purpose so later passes can raise good errors rather than failing to match.
const TEST: Record<LeafName, RegExp> = {
  [LeafName.FallNick]: /^\}+/,
  [LeafName.FallHold]: /^\)/,
  [LeafName.FallText]: /^>/,
  [LeafName.Link]: /^, */,
  [LeafName.Note]: /^# +[^\n]+/,
  [LeafName.Comb]: /^-?\d+\.\d+/,
  [LeafName.Code]: /^0[xXbBoO]\w+/,
  [LeafName.SlotLine]: /^\n/,
  [LeafName.RiseNick]: /^\{+/,
  [LeafName.RiseHold]: /^\(/,
  [LeafName.RiseText]: /^</,
  [LeafName.Slot]: /^ +/,
  [LeafName.Knit]: /^[@~$%^&*'":.a-z0-9A-Z_\-?/]+/,
  [LeafName.Size]: /^-?\d+(?=\b)/,
  [LeafName.Cord]: /^(?:\\[<>{}])+|[^{>\\]+/,
}

export function makeLeafList(link: { file: string; text: string }): LeafResult {
  const cast: LeafCast = {
    file: link.file,
    text: link.text,
    lineText: link.text.split('\n'),
  }

  const nickList: Array<string> = []
  const stateList: Array<LeafState> = [LeafState.Base]

  let line = 0
  let mark = 0
  let back: Leaf | undefined

  function save(stem: Leaf) {
    if (!cast.head) {
      cast.head = stem
    } else if (back) {
      stem.back = back
      back.head = stem
    }
  }

  for (let textLine of cast.lineText) {
    // append the newline so the slot-line matcher fires at the end of each line
    textLine = `${textLine}\n`

    while (textLine) {
      const state = stateList[stateList.length - 1] ?? LeafState.Base
      const testList = STATE_TESTS[state]
      let move = false

      for (const form of testList) {
        const find = textLine.match(TEST[form])
        if (!find) continue
        move = true

        let findSize = find[0].length
        let findText = textLine.slice(0, findSize)

        // a closing }} only consumes as many braces as the matching opener pushed
        if (form === LeafName.FallNick) {
          const last = nickList[nickList.length - 1]
          if (last) {
            findSize = last.length
            findText = findText.slice(0, last.length)
          }
        }

        const stem: Leaf = {
          form,
          band: { base: { mark, line }, head: { mark: mark + findSize, line } },
          text: findText,
        }
        save(stem)
        back = stem

        textLine = textLine.slice(findSize)
        mark += findSize

        if (form === LeafName.RiseNick) nickList.push(findText)
        else if (form === LeafName.FallNick) nickList.pop()

        switch (form) {
          case LeafName.SlotLine:
            line++
            mark = 0
            break
          case LeafName.RiseNick:
            stateList.push(LeafState.Nick)
            break
          case LeafName.FallNick:
            stateList.pop()
            break
          case LeafName.RiseText:
            stateList.push(LeafState.Text)
            break
          case LeafName.FallText:
            stateList.pop()
            break
          default:
            break
        }
        break
      }

      if (!move && back) {
        return { ok: false, diagnostics: [diagnose('syntax-error', { file: link.file, band: back.band })] }
      }
    }

    if (textLine.length && back) {
      return { ok: false, diagnostics: [diagnose('syntax-error', { file: link.file, band: back.band })] }
    }
  }

  return { ok: true, cast }
}
