// One-off migration: the two SETTLED keyword changes (markers like async/private are still in flux, left as `mark`).
//   note <...>            (doc comment)  -> # ...          (markdown comment)
//   mark <number|hex>     (literal)      -> code <number|hex>
// Operates on every .tree file under base.tree/code. Verified afterward by the full test suite.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd(), '../../deck/base.tree/code')

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (e.endsWith('.tree')) out.push(full)
  }
  return out
}

let changed = 0
for (const file of walk(root)) {
  const before = readFileSync(file, 'utf8')
  const after = before
    .split('\n')
    .map(line => {
      // doc note: `<indent>note <CONTENT>` -> `<indent># CONTENT` (CONTENT is everything between first < and last >)
      const note = line.match(/^(\s*)note <(.*)>\s*$/)
      if (note) return `${note[1]}# ${note[2]}`
      // literal: `mark <number|hex|negative>` -> `code ...` (anywhere on the line, e.g. `send back, mark 0`)
      return line.replace(/\bmark (-?\d[\w.]*|0[xXbBoO]\w+)/g, 'code $1')
    })
    .join('\n')
  if (after !== before) {
    writeFileSync(file, after)
    changed++
  }
}
console.log(`migrated ${changed} .tree files`)
