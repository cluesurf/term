import fsp from 'fs/promises';
import makeTree from '@cluesurf/tree';
import { KinkList } from '@cluesurf/kink';
export class Card {
    file;
    // text of the code
    text;
    // TreeCode representation
    tree;
    constructor({ file, text, tree }) {
        this.file = file;
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
//# sourceMappingURL=file.js.map