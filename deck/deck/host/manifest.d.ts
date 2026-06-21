import { DeckManifest } from './form';
export declare function loadManifest(input: {
    dir: string;
}): Promise<DeckManifest>;
export declare function parseManifest(input: {
    text: string;
}): DeckManifest;
export declare function writeManifest(input: {
    manifest: DeckManifest;
}): string;
