// The sift pass. The leaf list to a flat token stream of rise and fall markers (fork, knit, text, nick, nest)
// plus content tokens (cord, size, comb, code). Resolves indentation into nest levels, comma into sibling forks,
// and opens and closes knits, nicks, and texts. Detects the structural errors. Faithful port of @cluesurf/tree's
// sift pass, errors routed through the diagnostic system.

import type { Diagnostic } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type { Leaf, LeafCast } from '@/code/parser/leaf'
import { LeafName } from '@/code/parser/leaf'

export enum SiftName {
  FallNest = 'sift-fall-nest',
  FallNick = 'sift-fall-nick',
  FallText = 'sift-fall-text',
  FallLine = 'sift-fall-line',
  Note = 'sift-note',
  Comb = 'sift-comb',
  Code = 'sift-code',
  RiseNest = 'sift-rise-nest',
  RiseNick = 'sift-rise-nick',
  RiseText = 'sift-rise-text',
  RiseLine = 'sift-rise-line',
  Cord = 'sift-cord',
  Size = 'sift-size',
  RiseFork = 'sift-rise-fork',
  FallFork = 'sift-fall-fork',
  RiseKnit = 'sift-rise-knit',
  FallKnit = 'sift-fall-knit',
}

export type Sift =
  | { form: SiftName.RiseFork }
  | { form: SiftName.FallFork }
  | { form: SiftName.RiseKnit }
  | { form: SiftName.FallKnit }
  | { form: SiftName.RiseNest }
  | { form: SiftName.FallNest }
  | { form: SiftName.RiseLine }
  | { form: SiftName.FallLine }
  | { form: SiftName.RiseNick; leaf: Leaf; size: number }
  | { form: SiftName.FallNick; leaf: Leaf }
  | { form: SiftName.RiseText; leaf: Leaf }
  | { form: SiftName.FallText; leaf: Leaf }
  | { form: SiftName.Cord; leaf: Leaf }
  | { form: SiftName.Size; leaf: Leaf; bond: number }
  | { form: SiftName.Comb; leaf: Leaf; bond: number }
  | { form: SiftName.Code; leaf: Leaf; bond: number; mold: string }
  | { form: SiftName.Note; leaf: Leaf }

export type SiftCast = LeafCast & { siftList: Array<Sift> }

export type SiftResult =
  | { ok: true; cast: SiftCast }
  | { ok: false; diagnostics: Array<Diagnostic> }

enum Head {
  Card = 'card',
  Knit = 'knit',
  Text = 'text',
  Nick = 'nick',
  Line = 'line',
  Fork = 'fork',
  Nest = 'nest',
}

type HeadNote = { form: Head; seed?: Leaf }
type ReadNote = { tick: number; line?: boolean; have: boolean }

export function makeSiftList(link: LeafCast): SiftResult {
  const siftList: Array<Sift> = []
  const headList: Array<HeadNote> = [{ form: Head.Card }]
  const readNoteList: Array<ReadNote> = [{ tick: 0, have: true, line: true }]
  const diagnostics: Array<Diagnostic> = []

  let textSlot = 0
  let slotLine = true
  let lastTick = 0

  function saveHead(head: HeadNote) {
    headList.push(head)
  }
  function readHead(): HeadNote | undefined {
    return headList[headList.length - 1]
  }
  function tossHead() {
    headList.pop()
  }
  function loadReadNote(): ReadNote {
    return readNoteList[readNoteList.length - 1]!
  }
  function saveReadNote(move = 0) {
    readNoteList.push({ tick: lastTick + move, have: true, line: true })
  }
  function tossReadNote() {
    readNoteList.pop()
  }

  function fail(name: 'invalid-nesting' | 'invalid-indentation' | 'syntax-error', leaf: Leaf, hint?: string) {
    diagnostics.push(diagnose(name, { file: link.file, band: leaf.band, hint }))
  }

  let leaf: Leaf | undefined = link.head
  if (leaf) {
    do {
      switch (leaf.form) {
        case LeafName.RiseNick:
          castRiseNick(leaf)
          break
        case LeafName.FallNick:
          castFallNick()
          break
        case LeafName.RiseText:
          slotLine = false
          castRiseText(leaf)
          break
        case LeafName.FallText:
          castFallText(leaf)
          break
        case LeafName.RiseHold:
          // open parenthesis: close a pending knit
          if (readHead()?.form === Head.Knit) {
            tossHead()
            siftList.push({ form: SiftName.FallKnit })
          }
          break
        case LeafName.FallHold:
          castFallHold()
          break
        case LeafName.Link:
          castLink(leaf)
          break
        case LeafName.Note:
          slotLine = false
          break
        case LeafName.Comb:
          slotLine = false
          castComb(leaf)
          break
        case LeafName.Code:
          slotLine = false
          castCode(leaf)
          break
        case LeafName.Slot:
          castSlot(leaf)
          break
        case LeafName.SlotLine:
          fallBond()
          textSlot = 0
          slotLine = true
          break
        case LeafName.Cord:
          slotLine = false
          castCord(leaf)
          break
        case LeafName.Knit:
          slotLine = false
          castKnit(leaf)
          break
        case LeafName.Size:
          slotLine = false
          castSize(leaf)
          break
        default:
          break
      }
    } while ((leaf = leaf.head))
  }

  fallBond()

  if (diagnostics.length) return { ok: false, diagnostics }
  return { ok: true, cast: { ...link, siftList } }

  // Handle the first content node on a line. Validates indentation.
  function testBaseLine() {
    const readNote = loadReadNote()
    if (slotLine) {
      slotLine = false
      if (readNote.line === false) {
        // started on the same line as the opener, no indentation allowed
      } else {
        readNote.line = true
      }
    } else {
      if (!readNote.have) readNote.line = false
    }
    readNote.have = true
  }

  function castSlot(seed: Leaf) {
    // close any open knit
    while (readHead()?.form === Head.Knit) {
      siftList.push({ form: SiftName.FallKnit })
      tossHead()
    }

    if (slotLine) {
      slotLine = false
      const readNote = loadReadNote()
      let tick = Math.floor(seed.text.length / 2)

      if (seed.text.length % 2 !== 0) {
        fail('invalid-nesting', seed)
        tick = readNote.tick + 1
      } else if (tick > lastTick + 1) {
        if (readNoteList.length === 1) {
          fail('invalid-indentation', seed)
        }
        tick = lastTick + 1
      } else if (tick < readNote.tick) {
        tick = readNote.tick + 1
      }

      let diff = tick - readNote.tick
      while (diff-- > 0) {
        saveHead({ form: Head.Nest })
        siftList.push({ form: SiftName.RiseNest })
      }
      lastTick = tick
    } else {
      // a size leaf cannot have a following node on the same line
      if (seed.back?.form === LeafName.Size) {
        fail('invalid-nesting', seed)
      }
    }
  }

  function castRiseText(seed: Leaf) {
    saveReadNote(1)
    saveHead({ form: Head.Text })
    siftList.push({ form: SiftName.RiseText, leaf: seed })
    const readNote = loadReadNote()
    readNote.line = tailSlot(seed)
  }

  function tailSlot(seed: Leaf): boolean {
    if (seed.head && seed.head.form === LeafName.Cord) {
      return Boolean(seed.head.text.match(/^\s*\n$/))
    }
    return false
  }

  function castFallText(seed: Leaf) {
    siftList.push({ form: SiftName.FallText, leaf: seed })
    tossHead()
    tossReadNote()
  }

  function castCode(seed: Leaf) {
    testBaseLine()
    const find = seed.text.match(/^0([xXbBoO])([0-9a-fA-F]+)/)
    if (find) {
      const mold = find[1]!.toLowerCase()
      const bond = readCode(mold, find[2]!)
      siftList.push({ form: SiftName.Code, bond, mold, leaf: seed })
    } else {
      fail('syntax-error', seed, 'this looks like a code but is malformed')
    }
  }

  function castComb(seed: Leaf) {
    testBaseLine()
    const bond = parseFloat(seed.text)
    siftList.push({ form: SiftName.Comb, bond, leaf: seed })
  }

  function castCord(seed: Leaf) {
    const readNote = loadReadNote()
    if (readNote.line) {
      seed.text = seed.text.slice(readNote.tick * 2).trimEnd()
    }

    const last = siftList[siftList.length - 1]
    // merge consecutive cords inside a multiline text to keep things clean
    if (last?.form === SiftName.Cord && readNote.line) {
      if (seed.text) {
        if (last.leaf.text) {
          last.leaf.text = last.leaf.text.endsWith('\n')
            ? `${last.leaf.text}${seed.text}`
            : `${last.leaf.text} ${seed.text}`
        } else {
          last.leaf.text = seed.text
        }
      } else if (seed.head && seed.head.form === LeafName.Cord) {
        last.leaf.text += '\n\n'
      }
    } else {
      siftList.push({ form: SiftName.Cord, leaf: seed })
    }
  }

  function castSize(seed: Leaf) {
    testBaseLine()
    siftList.push({ form: SiftName.Size, leaf: seed, bond: parseInt(seed.text, 10) })
  }

  function readCode(mold: string, bond: string): number {
    switch (mold) {
      case 'b':
        return parseInt(bond, 2)
      case 'o':
        return parseInt(bond, 8)
      case 'x':
      default:
        return parseInt(bond, 16)
    }
  }

  // Handle the comma.
  function castLink(seed: Leaf) {
    if (readHead()?.form === Head.Knit) {
      tossHead()
      siftList.push({ form: SiftName.FallKnit })
      tossHead()
      siftList.push({ form: SiftName.FallFork })
    }
  }

  function castKnit(seed: Leaf) {
    castRiseKnit(seed)

    if (seed.text.includes('/')) {
      const followsNick = seed.back?.form === LeafName.FallNick
      const segments = seed.text.split('/')
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]!
        if (segment.startsWith('-') && !(i === 0 && followsNick)) {
          fail('syntax-error', seed, 'a path segment cannot start with a dash')
          break
        }
        const qIdx = segment.indexOf('?')
        if (qIdx !== -1 && qIdx !== segment.length - 1) {
          fail('syntax-error', seed, 'the optional mark ? must be at the end of a segment')
          break
        }
      }
    }

    siftList.push({
      form: SiftName.Cord,
      leaf: { form: LeafName.Cord, band: seed.band, text: seed.text, back: seed.back, head: seed.head },
    })
  }

  function castRiseKnit(seed: Leaf) {
    const last = seed.back
    switch (last?.form) {
      case LeafName.SlotLine:
      case LeafName.Link:
      case LeafName.RiseNick:
      case LeafName.Slot:
      case undefined:
        siftList.push({ form: SiftName.RiseFork })
        saveHead({ form: Head.Fork })
        testBaseLine()
        siftList.push({ form: SiftName.RiseKnit })
        saveHead({ form: Head.Knit })
        break
      default:
        break
    }
  }

  function castRiseNick(seed: Leaf) {
    switch (seed.back?.form) {
      case LeafName.Slot:
      case LeafName.SlotLine:
      case undefined:
        saveHead({ form: Head.Fork })
        siftList.push({ form: SiftName.RiseFork })
        saveHead({ form: Head.Knit })
        siftList.push({ form: SiftName.RiseKnit })
        break
      default:
        break
    }
    saveHead({ form: Head.Nick, seed })
    siftList.push({ form: SiftName.RiseNick, leaf: seed, size: seed.text.length })
    saveReadNote(1)
  }

  // Handle close parenthesis. Parentheses live on one line.
  function castFallHold() {
    walk: while (true) {
      const head = readHead()
      switch (head?.form) {
        case Head.Nest:
          siftList.push({ form: SiftName.FallNest })
          tossHead()
          break
        case Head.Fork:
          siftList.push({ form: SiftName.FallFork })
          tossHead()
          break
        case Head.Knit:
          siftList.push({ form: SiftName.FallKnit })
          tossHead()
          break
        default:
          break walk
      }
    }
  }

  // Close interpolation.
  function castFallNick() {
    walk: while (true) {
      const head = readHead()
      switch (head?.form) {
        case Head.Knit:
          siftList.push({ form: SiftName.FallKnit })
          tossHead()
          break
        case Head.Nest:
          siftList.push({ form: SiftName.FallNest })
          tossHead()
          break
        case Head.Fork:
          siftList.push({ form: SiftName.FallFork })
          tossHead()
          break
        case Head.Nick:
          siftList.push({ form: SiftName.FallNick, leaf: head.seed! })
          tossHead()
          break walk
        default:
          break walk
      }
    }
    tossReadNote()
  }

  // Close everything still open at the end of a line.
  function fallBond() {
    walk: while (true) {
      const head = readHead()
      switch (head?.form) {
        case Head.Fork:
          siftList.push({ form: SiftName.FallFork })
          tossHead()
          break
        case Head.Nest:
          siftList.push({ form: SiftName.FallNest })
          tossHead()
          break
        case Head.Knit:
          siftList.push({ form: SiftName.FallKnit })
          tossHead()
          break
        case Head.Line:
          siftList.push({ form: SiftName.FallLine })
          tossHead()
          break
        case Head.Card:
          break walk
        default:
          break walk
      }
    }
  }
}
