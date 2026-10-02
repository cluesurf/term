// The device traits in a browser (native-dom-0012), docked by ../device.tree as `<global:native-device>`.
//
// Each trait is a media query or a window measure, READ when asked: nothing is cached as truth. `recheck` reads every
// trait again and reports each one that differs from the last report, and the queries' own `change` events and the
// window's `resize` only trigger it. Outside a browser (a Worker, the server render) there is no window, and every
// trait reads its default, the same defaults the memory host gives.

type Report = (name: string, value: string) => void

const NAMES = ['idiom', 'width-class', 'pointer', 'color-scheme', 'reduce-motion', 'text-scale']
const QUERIES = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)', '(pointer: fine)', '(pointer: coarse)']

const live = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
const matches = (query: string): boolean => live() && window.matchMedia(query).matches

let report: Report | undefined
let last: Record<string, string> = {}
let installed = false

// the root font size over the browser default of 16, to two places, `1` at the default
function textScale(): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return '1'
  }

  const size = parseFloat(getComputedStyle(document.documentElement).fontSize)

  return Number.isFinite(size) && size > 0 ? String(Math.round((size / 16) * 100) / 100) : '1'
}

function readTrait(name: string): string {
  switch (name) {
    case 'idiom': {
      if (!live()) {
        return 'phone'
      }

      if (!matches('(pointer: coarse)')) {
        return 'desktop'
      }

      return Math.min(window.screen.width, window.screen.height) >= 600 ? 'tablet' : 'phone'
    }
    case 'width-class':
      return live() && window.innerWidth >= 600 ? 'regular' : 'compact'
    case 'pointer':
      return matches('(pointer: fine)') ? 'fine' : 'touch'
    case 'color-scheme':
      return matches('(prefers-color-scheme: dark)') ? 'dark' : 'light'
    case 'reduce-motion':
      return matches('(prefers-reduced-motion: reduce)') ? 'yes' : 'no'
    case 'text-scale':
      return textScale()
    default:
      return 'no'
  }
}

// read every trait again, and report each that the browser changed since the last report
function recheck(): void {
  if (!report) {
    return
  }

  for (const name of NAMES) {
    const now = readTrait(name)

    if (last[name] !== now) {
      last[name] = now
      report(name, now)
    }
  }
}

export const nativeDevice = {
  readTrait,
  recheck,

  watch(handler: Report): void {
    report = handler
    last = Object.fromEntries(NAMES.map(name => [name, readTrait(name)]))

    if (installed || !live()) {
      return
    }

    installed = true

    for (const query of QUERIES) {
      window.matchMedia(query).addEventListener('change', recheck)
    }

    window.addEventListener('resize', recheck)
  },

  unwatch(): void {
    report = undefined
  },

  // a page cannot force a media query, so this only asks again: a test changes the browser (or its stand-in) first
  changeTrait(_name: string, _value: string): void {
    recheck()
  },
}
