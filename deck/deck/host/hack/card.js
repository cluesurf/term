import fsp from 'fs/promises';
import makeTree from '@cluesurf/tree';
import { KinkList } from '@cluesurf/kink';
export class Card {
    link;
    // text of the code
    text;
    // TreeCode representation
    tree;
    constructor({ link, text, tree }) {
        this.link = link;
        this.text = text;
        this.tree = tree;
    }
}
export async function loadFile({ file }) {
    const text = await fsp.readFile(file, 'utf-8');
    const lead = makeTree({ file, text });
    if (lead instanceof KinkList) {
        throw lead;
    }
    return new Card({ file, text, tree: lead.tree });
}
//# sourceMappingURL=card.js.map