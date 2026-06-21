export declare function install(input: {
    root: string;
    clean?: boolean;
    offline?: boolean;
}): Promise<void>;
export declare function addDependency(input: {
    root: string;
    name: string;
    constraint?: string;
}): Promise<void>;
export declare function removeDependency(input: {
    root: string;
    name: string;
}): Promise<void>;
export declare function verifyInstall(input: {
    root: string;
}): Promise<{
    ok: boolean;
    missing: Array<string>;
    outdated: Array<string>;
}>;
