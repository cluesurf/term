// Deep structural equality over the dynamic value, the same semantics on every backend: identical scalars
// are equal, two lists are equal when their sizes match and every element pair is deep-equal, and anything
// else answers by identity. Kept behavior-identical to the Term implementation it replaced (see
// native/shared/test/compare.tree, 2026-08-31: the body moved into per-backend shims so the rust, swift and
// kotlin builds do not need structural operations over their boxed dynamics).
const compareRuntime = {
  deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
      return true
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        return false
      }

      for (let i = 0; i < a.length; i++) {
        if (!compareRuntime.deepEqual(a[i], b[i])) {
          return false
        }
      }

      return true
    }

    return false
  },

  contains(list: unknown, value: unknown): boolean {
    if (!Array.isArray(list)) {
      return false
    }

    return list.some(item => compareRuntime.deepEqual(item, value))
  },
  asText(value: unknown): string {
    return typeof value === 'string' ? value : ''
  },
  isTruthy(value: unknown): boolean {
    return Boolean(value)
  },
  numeric(value: unknown): number {
    return typeof value === 'number' ? value : Number.NaN
  },
  above(a: unknown, b: unknown): boolean {
    return compareRuntime.numeric(a) > compareRuntime.numeric(b)
  },
  below(a: unknown, b: unknown): boolean {
    return compareRuntime.numeric(a) < compareRuntime.numeric(b)
  },
  gap(a: unknown, b: unknown): number {
    return Math.abs(compareRuntime.numeric(a) - compareRuntime.numeric(b))
  },
}
