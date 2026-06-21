export type Mark = {
    major: number;
    minor: number;
    patch: number;
    prerelease?: string;
};
export type MarkBand = {
    form: 'band';
    base: Mark;
    head: Mark;
};
export type MarkWild = {
    form: 'wild';
    major: number;
    minor?: number;
    patch?: number;
};
export type MarkTest = {
    form: 'test';
    list: Array<MarkWild>;
};
export type MarkHold = MarkBand | MarkWild | MarkTest | {
    form: 'exact';
    mark: Mark;
};
export type DeckMind = {
    name: string;
    site?: string;
};
export type DeckLink = {
    name: string;
    mark: MarkHold;
    have?: number;
};
export type DeckManifest = {
    host: string;
    name: string;
    mark: Mark;
    head?: string;
    mind?: Array<DeckMind>;
    lock?: string;
    term?: Array<string>;
    link: Array<DeckLink>;
    hook?: Record<string, string>;
};
export type ResolvedDeck = {
    name: string;
    mark: Mark;
    hash: string;
    site: string;
    link: Map<string, string>;
};
export type ResolutionMap = {
    decks: Map<string, ResolvedDeck>;
};
export type LockEntry = {
    name: string;
    mark: Mark;
    hash: string;
    site: string;
    link: Array<{
        name: string;
        mark: string;
    }>;
};
export type Lockfile = {
    version: number;
    decks: Array<LockEntry>;
};
export type StoreConfig = {
    root: string;
};
export type FetchConfig = {
    registry: string;
    concurrency: number;
    offline: boolean;
};
export type RegistryPackageMeta = {
    name: string;
    versions: Record<string, {
        dist: {
            shasum: string;
            tarball: string;
            integrity: string;
        };
        dependencies?: Record<string, string>;
    }>;
    'dist-tags': Record<string, string>;
};
export type InstallConfig = {
    root: string;
    store: StoreConfig;
    fetch: FetchConfig;
    clean: boolean;
};
