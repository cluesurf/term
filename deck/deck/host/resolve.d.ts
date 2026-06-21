import { DeckManifest, FetchConfig, Lockfile, ResolutionMap } from './form';
export declare function resolve(input: {
    manifest: DeckManifest;
    config: FetchConfig;
    lockfile?: Lockfile;
    workspaces?: Map<string, DeckManifest>;
}): Promise<ResolutionMap>;
export declare function buildLockfile(input: {
    resolution: ResolutionMap;
}): Lockfile;
