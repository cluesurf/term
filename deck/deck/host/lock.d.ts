import { Lockfile } from './form';
export declare function loadLockfile(input: {
    dir: string;
}): Promise<Lockfile | undefined>;
export declare function parseLockfile(input: {
    text: string;
}): Lockfile;
export declare function writeLockfile(input: {
    lockfile: Lockfile;
}): string;
export declare function saveLockfile(input: {
    dir: string;
    lockfile: Lockfile;
}): Promise<void>;
