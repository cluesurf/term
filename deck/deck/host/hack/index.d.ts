import { TakeDeckLinkForm, TakeDeckForm, TakeDeckFindForm, TakeDeckLoadFileForm, DeckForm, DeckBaseForm } from '@cluesurf/base';
import { Card } from './file';
export { Card };
declare const DeckBase: DeckBaseForm;
export { DeckBase };
export declare class Deck implements DeckForm {
    #private;
    constructor({ home }: TakeDeckForm);
    load(): Promise<void>;
    save({ link, mark, site }: TakeDeckLinkForm): Promise<void>;
    toss({ link, mark, site }: TakeDeckLinkForm): Promise<void>;
    test({ link, mark, site }: TakeDeckLinkForm): Promise<boolean>;
    link({ link, mark }: TakeDeckLinkForm): Promise<void>;
    find({ file, base }: TakeDeckFindForm): Promise<string | void>;
    loadCard({ file }: TakeDeckLoadFileForm): Promise<Card>;
}
