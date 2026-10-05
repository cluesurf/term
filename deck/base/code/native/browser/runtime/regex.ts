// The one regex primitive over the host RegExp, with the u flag (code points) and the d flag (group indices). The
// pattern arrives in a form this engine reads as Term does (regex/dialect.tree, pattern/feature.tree), so this only
// runs it and turns UTF-16
// offsets into code point offsets.
const regex = {
  compiled: new Map<string, RegExp>(),
  search: (pattern: string, text: string, from: number): Array<number> => {
    let engine = regex.compiled.get(pattern)
    if (engine === undefined) {
      // an engine that refuses the pattern answers [-2], never "no match": Term answers it with its own tier
      try {
        engine = new RegExp(pattern, 'gud')
      } catch {
        return [-2]
      }
      regex.compiled.set(pattern, engine)
    }
    if (from < 0) return []
    let unit = 0
    let point = 0
    while (point < from && unit < text.length) {
      unit += (text.codePointAt(unit) ?? 0) > 0xffff ? 2 : 1
      point += 1
    }
    if (point < from) return []
    engine.lastIndex = unit
    const found = engine.exec(text)
    if (found === null || found.indices === undefined) return []
    // counted on from where the search began, or from the text's start for a group a lookbehind found before it
    const toPoint = (at: number): number => {
      let u = at < unit ? 0 : unit
      let p = at < unit ? 0 : from
      while (u < at) {
        u += (text.codePointAt(u) ?? 0) > 0xffff ? 2 : 1
        p += 1
      }
      return p
    }
    const out: Array<number> = []
    for (const span of found.indices) {
      if (span === undefined) {
        out.push(-1, -1)
      } else {
        out.push(toPoint(span[0]), toPoint(span[1]))
      }
    }
    return out
  },
  // every match left to right, none overlapping, in one pass: the width of one match's slots first (two per group,
  // group 0 the whole match), then each match's slots in code points. After an empty match the search moves on one
  // code point, as the Term search does, so every engine iterates alike. One pass keeps the UTF-16 to code point
  // count moving forwards, where a search per match would recount from the start each time.
  searchAll: (pattern: string, text: string): Array<number> => {
    let engine = regex.compiled.get(pattern)
    if (engine === undefined) {
      // an engine that refuses the pattern answers [-2], never "no match": Term answers it with its own tier
      try {
        engine = new RegExp(pattern, 'gud')
      } catch {
        return [-2]
      }
      regex.compiled.set(pattern, engine)
    }
    const out: Array<number> = [-1]
    // a cursor: the code point count at a UTF-16 offset, moved forwards only
    let cursorUnit = 0
    let cursorPoint = 0
    // counted on from a known offset, or from the text's start for a group a lookbehind found before that offset
    const pointAt = (at: number, fromUnit: number, fromPoint: number): number => {
      let u = at < fromUnit ? 0 : fromUnit
      let p = at < fromUnit ? 0 : fromPoint
      while (u < at) {
        u += (text.codePointAt(u) ?? 0) > 0xffff ? 2 : 1
        p += 1
      }
      return p
    }
    let unit = 0
    while (unit <= text.length) {
      engine.lastIndex = unit
      const found = engine.exec(text)
      if (found === null || found.indices === undefined) break
      const startUnit = found.indices[0]![0]
      const endUnit = found.indices[0]![1]
      const startPoint = pointAt(startUnit, cursorUnit, cursorPoint)
      cursorUnit = startUnit
      cursorPoint = startPoint
      out[0] = found.indices.length * 2
      for (const span of found.indices) {
        if (span === undefined) {
          out.push(-1, -1)
        } else {
          out.push(pointAt(span[0], startUnit, startPoint), pointAt(span[1], startUnit, startPoint))
        }
      }
      if (endUnit > startUnit) {
        unit = endUnit
      } else {
        unit = endUnit + ((text.codePointAt(endUnit) ?? 0) > 0xffff ? 2 : 1)
      }
    }
    return out
  },
}
