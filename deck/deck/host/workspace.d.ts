import { DeckManifest } from './form';
export declare function findWorkspaces(input: {
    root: string;
}): Promise<Map<string, DeckManifest>>;
export declare function findProjectRoot(input: {
    dir: string;
}): Promise<string | undefined>;
export declare function topologicalSort(input: {
    workspaces: Map<string, DeckManifest>;
}): Array<string>;
