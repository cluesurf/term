// The compiler's persistent cache store (Tier 1), as the TypeScript callers import it. A face over the Term port
// (decision 170 of change 001-finish-self-host): where an entry lives and the housekeeping are
// work/cache/entry-layout.tree, the store, the compiler's version per kind and the one cache per project a process
// keeps are work/cache/compile-store.tree. Both say why the layout is `<kind>/<version>/<shard>/<key>.json.gz`. One
// store writes cache entries on every path: the CLI bundle (through work/compose/reload-loop.tree) and every caller of
// this file. Nothing here reads or writes a file: each name is the port's, typed as its callers take it.

import type { CacheStore, CompileCache } from '@term/make/code/compile/cache'
import type { ParseMemo } from '@term/make/code/compile/load'
import * as layout from '@term/call/code/work/cache/entry-layout'
import * as store from '@term/call/code/work/cache/compile-store'

// how many compiler versions keep their entries: the current one plus one
export const KEEP_VERSIONS: number = layout.keepVersions()

// the byte budget per kind, call/code/cache-plan.tree's
export const OUTPUT_BUDGET_BYTES: number = layout.outputBudgetBytes()
export const MILL_BUDGET_BYTES: number = layout.millBudgetBytes()
export const UNIT_BUDGET_BYTES: number = layout.unitBudgetBytes()

export const budgetFor: (kind: string) => number = store.budgetFor

// the kinds kept machine-wide rather than per project
export const SHARED_KINDS: Set<string> = new Set(layout.sharedKinds())

// the budget is held once an hour, not once a process
export const BUDGET_INTERVAL_MS: number = layout.budgetIntervalMs()

export const versionSlug: (version: string) => string = layout.versionSlug

export const entryPath: (
  dir: string,
  kind: string,
  version: string,
  key: string,
) => string = layout.entryPath

export const entryPathBySlug: (
  dir: string,
  kind: string,
  slug: string,
  key: string,
) => string = layout.entryPathBySlug

export const storedEntries = layout.storedEntries as (
  dir: string,
  kinds: readonly string[],
) => { kind: string; version: string; key: string }[]

export const cacheEntries: (
  dir: string,
) => { file: string; size: number; when: number }[] = layout.cacheEntries

export const legacyCacheDirs: (projectRoot: string) => string[] =
  layout.legacyCacheDirs

export const asideCacheDirs: (projectRoot: string) => string[] =
  layout.asideCacheDirs

export const reclaimStaleVersions: (
  dir: string,
  kind: string,
  current: string,
  keep?: number,
) => string[] = layout.reclaimStaleVersions

export const enforceBudget: (
  dir: string,
  kind: string,
  slug: string,
  budget?: number,
) => { removed: number; freed: number } = layout.enforceBudget

export const budgetDue: (
  dir: string,
  kind: string,
  slug: string,
  now?: number,
) => boolean = layout.budgetDue

// `version` is a text for one namespace across every kind, or a function for a namespace PER KIND
export const diskCacheStore: (
  dir: string,
  version: string | ((kind: string) => string),
) => CacheStore = store.diskCacheStore

export const sharedCacheStore: (
  localDir: string,
  sharedDir: string,
  version: string | ((kind: string) => string),
) => CacheStore = store.sharedCacheStore

// the running compiler's fingerprint for one cache kind, and every kind's for a build worker
export const compilerVersion: (kind?: string) => string = store.compilerVersion

export const compilerVersions: () => Record<string, string> =
  store.compilerVersions

export const cacheHome: () => string = store.cacheHome

export const projectCacheDir: (projectRoot: string) => string =
  store.projectCacheDir

// `version` is every kind's version, which a build worker is handed; `millCap` the milled modules held in memory
export const projectCache: (
  projectRoot: string,
  version?: Record<string, string>,
  millCap?: number,
) => CompileCache = store.projectCache

// one cache per project and one parse memo for the life of the process
export const processCache: (projectRoot: string) => CompileCache =
  store.processCache

export const processParse: () => ParseMemo = store.processParse
