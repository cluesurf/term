/// <reference types="node" />
import fs from 'fs';
export declare function findFilePath({ file, base, }: {
    file: string;
    base: string;
}): Promise<string | void>;
export declare function findLeadLink(fileBase: string): string | void;
export declare function findLink(link: string, base: string): any;
export declare const readFilePath: typeof fs.realpathSync.native;
export declare function testFile(dir: string): boolean;
export declare function testFileBase(file: string): boolean;
