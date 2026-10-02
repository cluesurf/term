// The one regex primitive over the host RegExp, with the u flag (code points) and the d flag (group indices). The
// pattern arrives in the canonical dialect (base/code/regex/dialect.tree), so this only runs it and turns UTF-16
// offsets into code point offsets.
const regex = {
  compiled: new Map<string, RegExp>(),
  search: (pattern: string, text: string, from: number): Array<number> => {
    let engine = regex.compiled.get(pattern)
    if (engine === undefined) {
      engine = new RegExp(pattern, 'gud')
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
    const toPoint = (at: number): number => {
      let u = unit
      let p = from
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
}
