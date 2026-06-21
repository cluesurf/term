import { DeckManifest, FetchConfig } from './form';
export declare function collectFiles(input: {
    dir: string;
}): Promise<Array<string>>;
export declare function createTarball(input: {
    dir: string;
    files: Array<string>;
}): Promise<Buffer>;
export declare function validateManifest(input: {
    manifest: DeckManifest;
}): Promise<Array<string>>;
export declare function publishDeck(input: {
    dir: string;
    config: FetchConfig;
    dryRun: boolean;
}): Promise<void>;
