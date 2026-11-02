// A PROGRAM, COPIED, the answer `structuredClone` gives at a third of its time (item 0757). The separate build copies a
// unit's stubs before the checker writes on them and the kernel copies the program before it renames a clashing form,
// on every keystroke the language server answers, and those two clones were the largest cost left in one. Each copy
// stays: the checker writes what it is handed. Only the copier is faster.
//
// THE SAME COPY: an array, a plain object, a Map and a Set are copied with their keys in order and an `undefined` field
// kept, a primitive is itself, and a node met twice (a shared type) is one copy met twice, cycles included. Anything else
// goes to `structuredClone`: a Date or a class instance as it copies them, a function or a symbol as the error it raises.
// compile/node-rewrite.tree and compile/separate-units.tree read this through the host and fall back to
// `structuredClone` when it is absent. test/check/program-copy.tree holds the two equal.

export function copyProgram<T>(given: T): T {
  const copies = new Map<object, unknown>()

  const copy = (value: unknown): unknown => {
    if (typeof value !== 'object') {
      return typeof value === 'function' || typeof value === 'symbol' ? structuredClone(value) : value
    }

    if (value === null) return null

    const known = copies.get(value)

    if (known !== undefined) return known

    if (Array.isArray(value)) {
      const out: unknown[] = new Array(value.length)
      copies.set(value, out)

      for (let at = 0; at < value.length; at++) out[at] = copy(value[at])

      return out
    }

    const shape = Object.getPrototypeOf(value)

    if (shape === Object.prototype) {
      const out: Record<string, unknown> = {}
      copies.set(value, out)

      for (const key of Object.keys(value)) {
        const field = copy((value as Record<string, unknown>)[key])

        // a plain write of this one key would set the copy's prototype
        if (key === '__proto__') Object.defineProperty(out, key, { value: field, enumerable: true, writable: true, configurable: true })
        else out[key] = field
      }

      return out
    }

    if (shape === Map.prototype) {
      const out = new Map<unknown, unknown>()
      copies.set(value, out)

      for (const [key, field] of value as Map<unknown, unknown>) out.set(copy(key), copy(field))

      return out
    }

    if (shape === Set.prototype) {
      const out = new Set<unknown>()
      copies.set(value, out)

      for (const member of value as Set<unknown>) out.add(copy(member))

      return out
    }

    const out = structuredClone(value) as object
    copies.set(value, out)

    return out
  }

  return copy(given) as T
}

;(globalThis as { __termCopyProgram?: typeof copyProgram }).__termCopyProgram = copyProgram
