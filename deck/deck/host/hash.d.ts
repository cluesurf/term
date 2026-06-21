export declare function hashFile(input: {
    path: string;
}): Promise<string>;
export declare function hashBuffer(input: {
    data: Buffer;
}): Promise<string>;
export declare function hashText(input: {
    text: string;
}): Promise<string>;
export declare function verifyHash(input: {
    data: Buffer;
    expected: string;
}): boolean;
