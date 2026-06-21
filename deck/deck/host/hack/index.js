import pathResolver from 'path';
import { findFilePath } from './find';
import { installPackage } from './install';
import { savePackage, savePackageGlobally } from './add';
import { removePackage, removePackageGlobally } from './remove';
import { verifyPackage, verifyPackageGlobally } from './verify';
import { linkPackage, linkPackageGlobally } from './link';
import { Card, loadFile } from './file';
export { Card };
const DeckBase = {
    // save global package
    async save({ link, mark, site }) {
        return savePackageGlobally();
    },
    // remove global package
    async toss({ link, mark, site }) {
        return removePackageGlobally();
    },
    // verify global package
    async test({ link, mark, site }) {
        return verifyPackageGlobally();
    },
    // link global package
    async link({ link, mark, site }) {
        return linkPackageGlobally();
    },
};
export { DeckBase };
export class Deck {
    #home;
    #cards;
    #links;
    constructor({ home }) {
        this.#home = pathResolver.resolve(home);
        this.#links = {};
        this.#cards = {};
    }
    // install defined packages
    async load() {
        return installPackage({ home: this.#home });
    }
    // add a package
    async save({ link, mark, site }) {
        return savePackage();
    }
    // remove a package
    async toss({ link, mark, site }) {
        return removePackage();
    }
    // verify a deck
    async test({ link, mark, site }) {
        return verifyPackage();
    }
    // link a package
    async link({ link, mark }) {
        return linkPackage();
    }
    // resolve file link
    async find({ file, base }) {
        return findFilePath({ base: base ?? this.#home, file });
    }
    // load file as card
    async loadCard({ file }) {
        return loadFile({ file });
    }
}
//# sourceMappingURL=index.js.map