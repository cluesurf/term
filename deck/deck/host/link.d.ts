import { ResolutionMap } from './form';
import { FetchConfig } from './form';
export declare function linkPackages(input: {
    root: string;
    resolution: ResolutionMap;
    config: FetchConfig;
}): Promise<void>;
export declare function cleanLinks(input: {
    root: string;
}): Promise<void>;
export declare function devLink(input: {
    root: string;
    packageDir: string;
}): Promise<void>;
export declare function devUnlink(input: {
    root: string;
    name: string;
}): Promise<void>;
