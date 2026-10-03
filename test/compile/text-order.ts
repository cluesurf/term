// The three code-point text runtimes the emitters prepend (TermText on Kotlin and Swift, __termText on TypeScript),
// run on the same inputs and held to one reference written here from the definition: a text is its sequence of code
// points (note/term/stdlib/semantics.md). All three were rewritten on 2026-10-02 to read the string in place rather
// than copy it into an array per call, and this is what holds the rewrite to the meaning. The inputs cross surrogate
// pairs, a combining accent, the U+E000..U+FFFF range (where UTF-16 order and code point order disagree), Term's
// White_Space set, and the empty text.
// Run: npx tsx test/compile/text-order.ts   (TO_ONLY=kotlin, swift or typescript runs one)

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { KOTLIN_TEXT } from '@term/make/code/compile/kotlin'
import { SWIFT_TEXT } from '@term/make/code/compile/swift'
import { TEXT_PRELUDE } from '@term/make/code/compile/typescript'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

// ---- the reference, from the definition ----------------------------------------------------------------------------

const WHITE = new Set([9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288])
const cps = (s: string): string[] => Array.from(s)
const clamp = (x: number, n: number): number => Math.min(Math.max(x, 0), n)
const at = (h: string[], n: string[], i: number): boolean => n.every((c, k) => h[i + k] === c)
const find = (s: string, n: string, from: number): number => {
  const h = cps(s)
  const m = cps(n)
  const f = clamp(from, h.length)

  if (m.length === 0) return f
  for (let i = f; i + m.length <= h.length; i++) if (at(h, m, i)) return i
  return -1
}
const white = (c: string): boolean => WHITE.has(c.codePointAt(0)!)

type Value = string | number | string[]
type Case = { op: string; args: (string | number | null)[]; want: Value }

const ref: Record<string, (...a: never[]) => Value> = {
  length: (s: string) => cps(s).length,
  charAt: (s: string, i: number) => (i >= 0 && i < cps(s).length ? cps(s)[i]! : ''),
  charCodeAt: (s: string, i: number) => (i >= 0 && i < cps(s).length ? cps(s)[i]!.codePointAt(0)! : -1),
  indexOf: (s: string, n: string, from: number) => find(s, n, from),
  lastIndexOf: (s: string, n: string) => {
    const h = cps(s)
    const m = cps(n)
    for (let i = h.length - m.length; i >= 0; i--) if (at(h, m, i)) return i
    return -1
  },
  substring: (s: string, a: number, b: number) => {
    const h = cps(s)
    let x = clamp(a, h.length)
    let y = clamp(b, h.length)
    if (x > y) [x, y] = [y, x]
    return h.slice(x, y).join('')
  },
  split: (s: string, d: string) => (d === '' ? cps(s) : s.split(d)),
  trimStart: (s: string) => {
    const h = cps(s)
    let i = 0
    while (i < h.length && white(h[i]!)) i++
    return h.slice(i).join('')
  },
  trimEnd: (s: string) => {
    const h = cps(s)
    let j = h.length
    while (j > 0 && white(h[j - 1]!)) j--
    return h.slice(0, j).join('')
  },
  trim: (s: string) => (ref.trimEnd as (s: string) => string)((ref.trimStart as (s: string) => string)(s)),
  padStart: (s: string, w: number, f: string) => {
    const n = cps(s).length
    const fill = cps(f)
    if (n >= w || fill.length === 0) return s
    let out = ''
    for (let i = 0; i < w - n; i++) out += fill[i % fill.length]
    return out + s
  },
  compare: (a: string, b: string) => {
    const x = cps(a).map(c => c.codePointAt(0)!)
    const y = cps(b).map(c => c.codePointAt(0)!)
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1
  },
  replace: (s: string, a: string, b: string) => {
    const i = s.indexOf(a)
    return i < 0 ? s : s.slice(0, i) + b + s.slice(i + a.length)
  },
  replaceAll: (s: string, a: string, b: string) => s.split(a).join(b),
}

// ---- the inputs ----------------------------------------------------------------------------------------------------

const TEXTS = ['', 'a', 'abc', 'x😀yz😀', '😀', 'aＡ', 'a😀', '\t a😀 　', '𝄞𝄞b', 'é', 'é', 'ab😀cd😀ef', ' \u0085x ']
const NEEDLES = ['', 'a', '😀', 'y', 'zz', '😀e', 'ef']
const cases: Case[] = []
const add = (op: string, ...args: (string | number)[]): void => {
  cases.push({ op, args, want: (ref[op] as (...a: (string | number)[]) => Value)(...args) })
}

for (const s of TEXTS) {
  add('length', s)
  add('trim', s)
  add('trimStart', s)
  add('trimEnd', s)

  for (const i of [-1, 0, 1, 2, 5, 9]) {
    add('charAt', s, i)
    add('charCodeAt', s, i)
  }

  for (const n of NEEDLES) {
    add('lastIndexOf', s, n)

    for (const from of [0, 1, 3, 20]) {
      add('indexOf', s, n, from)
    }

    if (n !== '') {
      add('replace', s, n, '<>')
      add('replaceAll', s, n, '<>')
    }
  }

  for (const a of [-1, 0, 1, 3, 99]) {
    for (const b of [-1, 0, 2, 4, 99]) {
      add('substring', s, a, b)
    }
  }

  for (const d of ['', '😀', 'a']) {
    add('split', s, d)
  }

  for (const w of [0, 3, 7]) {
    for (const f of ['ab', '😀']) {
      add('padStart', s, w, f)
    }
  }

  for (const t of TEXTS) {
    add('compare', s, t)
  }
}

const show = (v: Value): string => (Array.isArray(v) ? `[${v.join('|')}]` : String(v))
const only = process.env.TO_ONLY ?? ''
const dir = mkdtempSync(join(tmpdir(), 'text-order-'))
const have = (tool: string): boolean => spawnSync('which', [tool]).status === 0

function judge(backend: string, lines: string[]): void {
  let wrong = 0

  cases.forEach((c, i) => {
    const got = lines[i]
    const want = show(c.want)

    if (got !== want) {
      wrong++

      if (wrong <= 8) {
        console.log(`        ${backend} ${c.op}(${c.args.map(a => JSON.stringify(a)).join(', ')}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
      }
    }
  })

  ok(`${backend}: ${cases.length} text operations agree with the code point reference`, wrong === 0, `${wrong} disagree`)
}

// ---- TypeScript ----------------------------------------------------------------------------------------------------

if (!only || only === 'typescript') {
  const js = transformSync(`${TEXT_PRELUDE}\nreturn __termText`, { loader: 'ts', format: 'cjs' }).code
  const text = new Function(js)() as Record<string, (...a: unknown[]) => Value>
  judge(
    'typescript',
    cases.map(c => {
      const v = text[c.op]!(...c.args)
      return show(c.op === 'compare' ? Math.sign(v as number) : v)
    }),
  )
}

// ---- Kotlin and Swift: one program each, a line per case ------------------------------------------------------------

const kotlinLiteral = (s: string): string => JSON.stringify(s).replace(/\$/g, '\\$')
const swiftLiteral = (s: string): string => JSON.stringify(s).replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => `\\u{${h}}`)

if ((!only || only === 'kotlin') && have('kotlinc') && have('java')) {
  const lines = cases.map(c => {
    const args = c.args.map(a => (typeof a === 'number' ? `${a}L` : kotlinLiteral(a as string))).join(', ')
    const call = `TermText.${c.op === 'split' ? 'split' : c.op}(${args})`

    return c.op === 'split'
      ? `    println("[" + ${call}.joinToString("|") + "]")`
      : c.op === 'compare'
        ? `    println(java.lang.Long.signum(${call}))`
        : `    println(${call})`
  })
  // a function per hundred lines: one main of thousands overflows the JVM's 64 KB method limit
  const chunks: string[] = []
  for (let i = 0; i < lines.length; i += 100) chunks.push(`fun part${i / 100}() {\n${lines.slice(i, i + 100).join('\n')}\n}`)
  const file = join(dir, 'text.kt')
  writeFileSync(file, `${KOTLIN_TEXT}\n${chunks.join('\n')}\nfun main() {\n${chunks.map((_, k) => `    part${k}()`).join('\n')}\n}\n`)
  execFileSync('kotlinc', [file, '-include-runtime', '-d', join(dir, 'text.jar')], { stdio: ['ignore', 'pipe', 'pipe'] })
  judge('kotlin', execFileSync('java', ['-jar', join(dir, 'text.jar')]).toString().split('\n'))
} else if (!only || only === 'kotlin') {
  console.log('skip  kotlin (kotlinc or java not installed)')
}

if ((!only || only === 'swift') && have('swiftc')) {
  const lines = cases.map(c => {
    const args = c.args.map(a => (typeof a === 'number' ? String(a) : swiftLiteral(a as string))).join(', ')
    const call = `TermText.${c.op}(${args})`

    // interpolation, never `+` chains: Swift's type checker takes minutes over a few hundred `"[" + x + "]"` lines
    return c.op === 'split'
      ? `    print("[\\(${call}.joined(separator: "|"))]")`
      : c.op === 'compare'
        ? `    print(${call}.signum())`
        : `    print(${call})`
  })
  // a function per hundred lines, and -Onone: this holds meaning, and the optimizer adds minutes for nothing here
  const chunks: string[] = []
  for (let i = 0; i < lines.length; i += 100) chunks.push(`func part${i / 100}() {\n${lines.slice(i, i + 100).join('\n')}\n}`)
  const file = join(dir, 'text.swift')
  writeFileSync(file, `${SWIFT_TEXT}\n${chunks.join('\n')}\n${chunks.map((_, k) => `part${k}()`).join('\n')}\n`)
  execFileSync('swiftc', ['-Onone', '-o', join(dir, 'text-swift'), file], { stdio: ['ignore', 'pipe', 'pipe'] })
  judge('swift', execFileSync(join(dir, 'text-swift')).toString().split('\n'))
} else if (!only || only === 'swift') {
  console.log('skip  swift (swiftc not installed)')
}

console.log(`\ntext-order: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
