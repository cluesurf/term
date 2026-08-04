// A token-level text diff, finer than git's line diff. The same engine runs at line,
// word, or character granularity, so a one-word edit inside a long string field is a
// one-word change, not a whole-value replacement. It powers the readable diff of text
// values in `.tree` files and of arbitrary non-binary files, and the three-way text
// merge in ./merge. The algorithm is Myers' O(ND) shortest edit script, which is
// optimal in edit distance and near-linear when changes are small.
//
// See note/library/base/design/history-operations.md.

export type Granularity = 'line' | 'word' | 'char'

// Split text into tokens for the given granularity. Whitespace is kept as its own
// tokens (word/char) or folded into lines, so joining the tokens reproduces the input
// exactly.
export function tokenize(text: string, granularity: Granularity): Array<string> {
  if (text.length === 0) {
    return []
  }
  switch (granularity) {
    case 'line':
      return text.split('\n')
    case 'word':
      // runs of whitespace and runs of non-whitespace, in order
      return text.match(/\s+|\S+/gu) ?? []
    case 'char':
      return [...text]
  }
}

// Reassemble tokens produced by `tokenize` at the same granularity.
export function detokenize(tokens: Array<string>, granularity: Granularity): string {
  return tokens.join(granularity === 'line' ? '\n' : '')
}

// One aligned step of the edit script.
export type Edit =
  | { tag: 'eq'; a: number; b: number }
  | { tag: 'del'; a: number }
  | { tag: 'ins'; b: number }

// Myers' shortest edit script between two token arrays.
export function diffTokens(a: Array<string>, b: Array<string>): Array<Edit> {
  const n = a.length
  const m = b.length
  const max = n + m
  // v is indexed by diagonal k in [-max, max]; offset to keep it a plain array
  const offset = max
  const v = new Array<number>(2 * max + 1).fill(0)
  const trace: Array<Array<number>> = []

  let solved = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]! // move down (insertion from b)
      } else {
        x = v[offset + k - 1]! + 1 // move right (deletion from a)
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        solved = d
        break
      }
    }
    if (solved >= 0) {
      break
    }
  }

  // Backtrack through the saved traces to recover the edit script.
  const edits: Array<Edit> = []
  let x = n
  let y = m
  for (let d = solved; d > 0; d--) {
    const vd = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = vd[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      edits.push({ tag: 'eq', a: x - 1, b: y - 1 })
      x--
      y--
    }
    if (x === prevX) {
      edits.push({ tag: 'ins', b: y - 1 })
    } else {
      edits.push({ tag: 'del', a: x - 1 })
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    edits.push({ tag: 'eq', a: x - 1, b: y - 1 })
    x--
    y--
  }
  edits.reverse()
  return edits
}

// A readable diff hunk: a run of equal, inserted, or removed text.
export type Hunk =
  | { tag: 'eq'; text: string }
  | { tag: 'ins'; text: string }
  | { tag: 'del'; text: string }

// Diff two strings into coalesced hunks at the chosen granularity.
export function diffText(
  before: string,
  after: string,
  granularity: Granularity = 'line',
): Array<Hunk> {
  const a = tokenize(before, granularity)
  const b = tokenize(after, granularity)
  const edits = diffTokens(a, b)
  const join = (ts: Array<string>): string => detokenize(ts, granularity)

  const hunks: Array<Hunk> = []
  let run: { tag: Hunk['tag']; tokens: Array<string> } | undefined
  const flush = (): void => {
    if (run !== undefined) {
      hunks.push({ tag: run.tag, text: join(run.tokens) })
      run = undefined
    }
  }
  for (const e of edits) {
    const tag: Hunk['tag'] = e.tag === 'eq' ? 'eq' : e.tag === 'ins' ? 'ins' : 'del'
    const token = e.tag === 'ins' ? b[e.b]! : a[e.a]!
    if (run === undefined || run.tag !== tag) {
      flush()
      run = { tag, tokens: [token] }
    } else {
      run.tokens.push(token)
    }
  }
  flush()
  return hunks
}

// A hunk grouping used by the three-way merge: for each change region in a diff, the
// span of the base it replaces and the replacement tokens.
export type ChangeHunk = { start: number; length: number; content: Array<string> }

// Group an edit script into change hunks over the base sequence (deletions and
// insertions coalesced), leaving equal runs implicit.
export function changeHunks(a: Array<string>, b: Array<string>): Array<ChangeHunk> {
  const edits = diffTokens(a, b)
  const hunks: Array<ChangeHunk> = []
  let ai = 0
  let open: ChangeHunk | undefined
  const openAt = (start: number): ChangeHunk => {
    if (open === undefined) {
      open = { start, length: 0, content: [] }
    }
    return open
  }
  const close = (): void => {
    if (open !== undefined) {
      hunks.push(open)
      open = undefined
    }
  }
  for (const e of edits) {
    if (e.tag === 'eq') {
      close()
      ai = e.a + 1
    } else if (e.tag === 'del') {
      const h = openAt(ai)
      h.length++
      ai = e.a + 1
    } else {
      const h = openAt(ai)
      h.content.push(b[e.b]!)
    }
  }
  close()
  return hunks
}
