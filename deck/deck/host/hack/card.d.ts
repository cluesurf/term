import { Tree } from '@cluesurf/tree';
import { CardForm, TakeCardForm } from './form';
export declare class Card implements CardForm {
    link: string;
    text: string;
    tree: Tree;
    constructor({ link, text, tree }: TakeCardForm);
}
export declare function loadFile({ file }: {
    file: string;
}): Promise<Card>;
