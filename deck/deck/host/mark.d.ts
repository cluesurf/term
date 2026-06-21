import { Mark, MarkHold } from './form';
export declare function parseMark(text: string): Mark;
export declare function parseMarkHold(text: string): MarkHold;
export declare function showMark(mark: Mark): string;
export declare function compareMark(a: Mark, b: Mark): number;
export declare function markMatch(mark: Mark, hold: MarkHold): boolean;
export declare function pickBestMark(input: {
    versions: Array<Mark>;
    hold: MarkHold;
}): Mark | undefined;
export declare function bumpMark(input: {
    mark: Mark;
    level: 1 | 2 | 3;
}): Mark;
