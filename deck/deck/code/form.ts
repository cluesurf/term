export type Code = {
  major: number
  minor: number
  patch: number
  prerelease?: string
  // `+build.4`: kept and printed, and ignored when two versions are compared, as semver says
  build?: string
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

// `base alice, <ghcr.io/alice-gh/term>`: where one scope's packages come from, for this project only
export type DeckBase = {
  // with its `@`: `@alice`
  scope: string
  // `ghcr.io/alice-gh/term`, `oci://localhost:5000/x`, or an npm-style `https://` registry
  registry: string
}

export type RoleRule = {
  name: string
  // `mark <name>` flags on the rule: how the files it matches are READ, rather than which mill reads them.
  // `lean` is the only one today (note/term/lean.md). A list of words rather than one field per flag, so a
  // second setting needs no change here and no change to the grammar.
  mark: string[]
  take: {
    pattern: string
    miss: string[]
  }[]
}

export type RoleConfig = {
  rules: RoleRule[]
}

// `link @scope/name, mark <0.0.x>`: a dependency and the versions it accepts. The constraint is `mark`, the word the
// manifest's own version uses (note/term/plan/manifest-mark-and-code-root.md). `code` names a folder now.
export type DeckLink = {
  name: string
  mark: CodeHold
  have?: number
}

export type DeckManifest = {
  host: string
  name: string
  // `mark <1.4.2>`: the version. `code <1.4.2>` is its old spelling, still read
  mark: Code
  // `code ./src`: the code root, the folder a package path resolves in first. Absent means `./code`, and the
  // writer leaves it out then. `bear ./code` is its old spelling, still read
  code?: string
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
  base?: DeckBase[]
  // A field the model does not carry is DELETED the next time anything writes the manifest, because the writer
  // emits the model and nothing else. Every dependency verb round-trips (`term save`, `term toss`, `term link`,
  // `term move`), so `term toss` on a dependency that was never there used to break the project: it dropped
  // `bear ./code` and `boot ./code/boot`, and the build then failed on an unresolvable entry. Nine of the
  // packages in this tree lost `bear` that way, and `text`, `make`, `cite` and `tool` went with it.
  //
  // These are the rest of the fields the manifest GRAMMAR knows (deck/deck/code/grammar.ts). They are spelled out
  // rather than swept into one catch-all bag, and deck/deck/test/round-trip.ts holds every real manifest in the
  // tree through a load and a write so the next field added to the grammar cannot go missing quietly.
  // `boot ./code/boot`: the app entry, what `term wake` scaffolds and `term boot` runs
  boot?: string
  // `tool ./tool`: the tools directory
  tool?: string
  // `text <The Term Secret Access Library>`: the long title
  text?: string
  // `make <security>`: a keyword, repeatable
  make?: string[]
  // `cite <Name>, base <email>`: attribution, the same shape as `mind`
  cite?: DeckMind[]
}

export type ResolvedDeck = {
  name: string
  code: Code
  // the integrity the registry declared, or for an `oci://` package the manifest digest
  hash: string
  // the tarball url, or for an `oci://` package the pinned reference `oci://<host>/<repository>@sha256:…`
  site: string
  // the signer's public key, for an `oci://` package: pinned so a re-signed version fails the next install
  key?: string
  link: Map<string, string>
  // a deck from the project's own `deck/` folder: the folder itself, which `link/` points at. Nothing is fetched or
  // stored for it, and nothing is written to the lock for its site
  local?: string
}

export type ResolutionMap = {
  decks: Map<string, ResolvedDeck>
}

export type LockEntry = {
  name: string
  code: Code
  hash: string
  site: string
  key?: string
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
  // keyed by scope including the leading `@` (e.g. `@term`). a value is an
  // npm-style https registry or an OCI one, `oci://<host>/<namespace>`, and
  // `@term` -> oci://ghcr.io/cluesurf/term is wired by default.
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
