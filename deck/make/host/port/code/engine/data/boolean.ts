function __termInt(x: number): number {
  if (!(x <= 9007199254740991 && x >= -9007199254740991)) __termIntStop(x)
  return x
}
function __termIntStop(x: number): never {
  const base = !Number.isFinite(x)
    ? { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing: "a division or remainder by zero" } }
    : { host: "@term/base", form: x > 0 ? "excess" : "shortage", note: x > 0 ? "Too large" : "Too small", code: "", time: Date.now(), link: { thing: "number", limit: x > 0 ? 9007199254740991 : -9007199254740991, actual: x } }
  throw Object.assign(new Error(base.note), base, { name: "TermException" })
}

export function makeFalse(): number {
  return -1
}

export function makeUnknown(): number {
  return 0
}

export function makeTrue(): number {
  return 1
}

export function fromBoolean(value: boolean): number {
  if (value) {
    return 1
  }
  return -1
}

export function toBoolean(value: number): boolean {
  return value === 1
}

export function notTernary(a: number): number {
  const __n0 = 0 - a; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); return __n0
}

export function andTernary(a: number, b: number): number {
  if (b < a) {
    return b
  }
  return a
}

export function orTernary(a: number, b: number): number {
  if (b > a) {
    return b
  }
  return a
}

export function impliesTernary(a: number, b: number): number {
  return orTernary(__termInt(0 - a), b)
}

export function xorTernary(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0
  }
  if (a === b) {
    return -1
  }
  return 1
}

export function isDefinite(a: number): boolean {
  return a !== 0
}

export function toString(a: number): string {
  if (a === 1) {
    return "true"
  }
  if (a === -1) {
    return "false"
  }
  return "unknown"
}
