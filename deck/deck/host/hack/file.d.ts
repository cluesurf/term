import { Tree } from '@cluesurf/tree';
import { CardForm, TakeCardForm } from '@cluesurf/base';
export declare class Card implements CardForm {
    file: string;
    text: string;
    tree: Tree;
    constructor({ file, text, tree }: TakeCardForm);
}
export declare function loadFile({ file }: {
    file: string;
}): Promise<Card>;
