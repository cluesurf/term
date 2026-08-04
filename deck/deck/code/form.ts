export type Mark = {
  major: number
  minor: number
  patch: number
  prerelease?: string
}

export type MarkBand = {
  form: 'band'
  base: Mark
  head: Mark
}

export type MarkWild = {
  form: 'wild'
  major: number
  minor?: number
  patch?: number
}

export type MarkTest = {
  form: 'test'
  list: MarkWild[]
}

export type MarkHold =
  | MarkBand
  | MarkWild
  | MarkTest
  | { form: 'exact'; mark: Mark }

export type DeckMind = {
  name: string
  base?: string
  site?: string
}

export type DeckHostGroup = {
  registry: string
  link: DeckLink[]
}

export type RoleRule = {
  name: string
  take: {
    pattern: string
    miss: string[]
  }[]
}

export type RoleConfig = {
  rules: RoleRule[]
}

export type DeckLink = {
  name: string
  mark: MarkHold
  have?: number
}

export type DeckManifest = {
  host: string
  name: string
  mark: Mark
  head?: string
  mind?: DeckMind[]
  lock?: string
  sort?: string
  term?: string[]
  link: DeckLink[]
  hook?: Record<string, string>
  role?: string
  test?: string
  book?: string
  line?: string
  call?: string
  task?: string
  hide?: boolean
  site?: string
  view?: string
  deck?: string[]
  devLink?: DeckLink[]
  hostLink?: DeckHostGroup[]
}

export type ResolvedDeck = {
  name: string
  mark: Mark
  hash: string
  site: string
  link: Map<string, string>
}

export type ResolutionMap = {
  decks: Map<string, ResolvedDeck>
}

export type LockEntry = {
  name: string
  mark: Mark
  hash: string
  site: string
  link: { name: string; mark: string }[]
}

export type Lockfile = {
  version: number
  decks: LockEntry[]
}

export type StoreConfig = {
  root: string
}

export type FetchConfig = {
  // the fallback registry used for any package whose scope has no
  // explicit mapping in `scopeRegistries` (defaults to npmjs.org)
  registry: string
  // per-scope registry overrides, npm's `@scope:registry` mechanism.
  // keyed by scope including the leading `@` (e.g. `@term`). the term
  // registry (`@term` -> https://tool.base.surf) is wired by default.
  scopeRegistries?: Record<string, string>
  concurrency: number
  offline: boolean
}

export type RegistryPackageMeta = {
  name: string
  versions: Record<
    string,
    {
      dist: {
        shasum: string
        tarball: string
        integrity: string
      }
      dependencies?: Record<string, string>
    }
  >
  'dist-tags': Record<string, string>
}

export type InstallConfig = {
  root: string
  store: StoreConfig
  fetch: FetchConfig
  clean: boolean
}
