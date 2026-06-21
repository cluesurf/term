export declare function getStoreRoot(): string;
export declare function getTreeDir(): string;
export declare function getDeckDir(): string;
export declare function getFilePath(input: {
    hash: string;
}): string;
export declare function initStore(): Promise<void>;
export declare function hasFile(input: {
    hash: string;
}): Promise<boolean>;
export declare function storeFile(input: {
    data: Buffer;
    hash: string;
}): Promise<string>;
export declare function storeDeckMeta(input: {
    registry: string;
    name: string;
    mark: string;
    data: string;
}): Promise<void>;
export declare function loadDeckMeta(input: {
    registry: string;
    name: string;
    mark: string;
}): Promise<string | undefined>;
export declare function pruneStore(input: {
    usedHashes: Set<string>;
}): Promise<{
    removed: number;
    bytes: number;
}>;
