// The single source of truth for every code-generation backend: its target language, whether it is production-ready or
// experimental, and (for experimental ones) the precise limitations a user must know before relying on it. The CLI's
// target selection, the emitters' experimental banners, and the backend tests all read from here, so a backend's
// stability is stated in exactly one place.

export type BackendStability = 'stable' | 'experimental'

export type BackendInfo = {
  // the target name as written on the command line / passed to the emitter (`rust`, `wgsl`, ...)
  name: string
  // the human-facing language / format name (`Rust`, `WGSL`, ...)
  language: string
  stability: BackendStability
  // for an experimental backend, the specific things that do not work yet; empty for a stable one
  limitations: string[]
}

export const BACKENDS: Record<string, BackendInfo> = {
  typescript: {
    name: 'typescript',
    language: 'TypeScript',
    stability: 'stable',
    limitations: [],
  },
  rust: {
    name: 'rust',
    language: 'Rust',
    stability: 'stable',
    limitations: [],
  },
  swift: {
    name: 'swift',
    language: 'Swift',
    stability: 'stable',
    limitations: [],
  },
  kotlin: {
    name: 'kotlin',
    language: 'Kotlin',
    stability: 'stable',
    limitations: [],
  },
  wgsl: {
    name: 'wgsl',
    language: 'WGSL',
    stability: 'experimental',
    limitations: [
      'Numeric-only by design: no strings, maps, records, closures, or async. It targets the GPU data-parallel fragment (numbers, floats, booleans, and arrays of them).',
    ],
  },
  hvm: {
    name: 'hvm',
    language: 'HVM',
    stability: 'experimental',
    limitations: [
      'The pure fragment is lowered: numbers, booleans, arithmetic / comparison, named-function calls, recursion, and value conditionals (an `if` becomes a numeric match). Strings, collections, records, stored closures, and loops are not yet lowered and are flagged with a SEED-UNSUPPORTED marker.',
    ],
  },
}

export function backendInfo(name: string): BackendInfo | undefined {
  return BACKENDS[name]
}

export function isExperimentalBackend(name: string): boolean {
  return BACKENDS[name]?.stability === 'experimental'
}

// the experimental notice for a backend, as plain lines (no comment syntax). Empty for a stable or unknown backend.
// The emitters wrap these in their own comment prefix; the CLI prints them as a warning.
export function experimentalNotice(name: string): string[] {
  const info = BACKENDS[name]

  if (!info || info.stability !== 'experimental') {
    return []
  }

  return [
    `EXPERIMENTAL backend: ${info.language}. Output is not production-ready.`,
    ...info.limitations.map(line => `- ${line}`),
  ]
}

// the experimental notice as a comment block in the target language's own comment syntax, ready to prepend to emitted
// source. `prefix` is the line-comment marker (`//` for WGSL). Empty string for a stable backend.
export function experimentalBanner(name: string, prefix: string): string {
  const notice = experimentalNotice(name)

  if (notice.length === 0) {
    return ''
  }

  return notice.map(line => `${prefix} ${line}`).join('\n') + '\n\n'
}
