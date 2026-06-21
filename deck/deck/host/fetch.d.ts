import { FetchConfig, Mark, RegistryPackageMeta } from './form';
export declare function makeDefaultFetchConfig(): FetchConfig;
export declare function fetchPackageMeta(input: {
    name: string;
    config: FetchConfig;
}): Promise<RegistryPackageMeta>;
export declare function fetchTarball(input: {
    url: string;
    config: FetchConfig;
}): Promise<Buffer>;
export declare function getVersionList(input: {
    meta: RegistryPackageMeta;
}): Array<Mark>;
export declare function getVersionMeta(input: {
    meta: RegistryPackageMeta;
    mark: string;
}): {
    tarball: string;
    integrity: string;
    shasum: string;
    dependencies: Record<string, string>;
} | undefined;
export declare function clearMetaCache(): void;
