export declare function toRegistryName(input: {
    name: string;
}): string;
export declare function toTreeName(input: {
    name: string;
}): string;
export declare function isScoped(input: {
    name: string;
}): boolean;
export declare function parseScope(input: {
    name: string;
}): {
    scope: string;
    base: string;
};
