// the bit shim's fast paths against the BigInt reference they replace, on edges and on random values
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const source = readFileSync(new URL('../deck/base/code/native/node/runtime/bit.ts', import.meta.url), 'utf8')
const js = transformSync(`${source}\nreturn bit`, { loader: 'ts', format: 'cjs' }).code
type Bit = Record<string, (a: number, b: number) => number>
const bit = new Function(js)() as Bit

const big = (x: number): bigint => BigInt(Math.trunc(x))
const ref: Record<string, (a: number, b: number) => number> = {
  and: (a, b) => Number(BigInt.asIntN(64, big(a) & big(b))),
  or: (a, b) => Number(BigInt.asIntN(64, big(a) | big(b))),
  exclusiveOr: (a, b) => Number(BigInt.asIntN(64, big(a) ^ big(b))),
  not: a => Number(BigInt.asIntN(64, ~big(a))),
  shiftLeft: (a, b) => Number(BigInt.asIntN(64, big(a) << big(b))),
  shiftRight: (a, b) => Number(BigInt.asIntN(64, big(a) >> big(b))),
  shiftRightUnsigned: (a, b) => Number(BigInt.asUintN(64, big(a)) >> big(b)),
}

const edges = [0, -0, 1, -1, 2, -2, 255, 0x7fffffff, -0x80000000, 0x80000000, 0xffffffff, 0x100000000, -0x80000001, 2 ** 52, -(2 ** 52), 2 ** 53 - 1, -(2 ** 53 - 1), 12345678901, -98765432109]
let seed = 7
const random = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  const kind = seed % 4
  const r = seed / 2147483648
  return kind === 0 ? Math.floor(r * 2 ** 31) * (seed % 2 ? 1 : -1) : kind === 1 ? Math.floor(r * 2 ** 32) : kind === 2 ? Math.floor(r * 2 ** 53) * (seed % 3 ? 1 : -1) : Math.floor(r * 300) - 150
}
const values = [...edges, ...Array.from({ length: 3000 }, random)]
const counts = [0, 1, 2, 5, 16, 31, 32, 33, 52, 53, 62, 63, 64, 70]
let checked = 0
let wrong = 0

for (const name of Object.keys(ref)) {
  const shift = name.startsWith('shift')
  const rights = shift ? counts : name === 'not' ? [0] : values.slice(0, 400)

  for (const a of values) {
    for (const b of rights) {
      const got = bit[name]!(a, b)
      const want = ref[name]!(a, b)
      checked++

      if (!Object.is(got, want) && !(got === 0 && want === 0)) {
        wrong++

        if (wrong < 10) {
          console.log(`FAIL ${name}(${a}, ${b}) = ${got}, want ${want}`)
        }
      }
    }
  }
}

console.log(`bit-check: ${checked} checked, ${wrong} wrong`)
process.exit(wrong ? 1 : 0)
