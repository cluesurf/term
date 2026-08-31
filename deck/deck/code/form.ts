export type Code = {
  major: number
  minor: number
  patch: number
  prerelease?: string
}

export type MarkBand = {
  form: 'band'
  base: Code
  head: Code
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

export type CodeHold =
  | MarkBand
  | MarkWild
  | MarkTest
  | { form: 'exact'; code: Code }

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
  code: CodeHold
  have?: number
}

export type DeckManifest = {
  host: string
  name: string
  code: Code
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
  // A field the model does not carry is DELETED the next time anything writes the manifest, because the writer
  // emits the model and nothing else. Every dependency verb round-trips (`term save`, `term toss`, `term link`,
  // `term move`), so `term toss` on a dependency that was never there used to break the project: it dropped
  // `bear ./code` and `boot ./code/boot`, and the build then failed on an unresolvable entry. Nine of the
  // packages in this tree lost `bear` that way, and `text`, `mark`, `make`, `cite` and `tool` went with it.
  //
  // These are the rest of the fields the manifest GRAMMAR knows (deck/deck/code/grammar.ts). They are spelled out
  // rather than swept into one catch-all bag, and deck/deck/test/round-trip.ts holds every real manifest in the
  // tree through a load and a write so the next field added to the grammar cannot go missing quietly.
  // `bear ./code`: what the package exports
  bear?: string
  // `boot ./code/boot`: the app entry, what `term wake` scaffolds and `term boot` runs
  boot?: string
  // `tool ./tool`: the tools directory
  tool?: string
  // `text <The Term Secret Access Library>`: the long title
  text?: string
  // `mark <0.0.1>`, the version's older spelling, or `mark private`
  mark?: string
  // `make <security>`: a keyword, repeatable
  make?: string[]
  // `cite <Name>, base <email>`: attribution, the same shape as `mind`
  cite?: DeckMind[]
}

export type ResolvedDeck = {
  name: string
  code: Code
  hash: string
  site: string
  link: Map<string, string>
}

export type ResolutionMap = {
  decks: Map<string, ResolvedDeck>
}

export type LockEntry = {
  name: string
  code: Code
  hash: string
  site: string
  link: { name: string; code: string }[]
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
