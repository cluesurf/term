var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
const SEED_DIR = '.seed';
export function getStoreRoot() {
    return path.join(os.homedir(), SEED_DIR);
}
export function getTreeDir() {
    return path.join(getStoreRoot(), 'tree');
}
export function getDeckDir() {
    return path.join(getStoreRoot(), 'deck');
}
export function getFilePath(input) {
    const prefix = input.hash.slice(0, 2);
    return path.join(getTreeDir(), prefix, input.hash);
}
export function initStore() {
    return __awaiter(this, void 0, void 0, function* () {
        yield fsp.mkdir(getTreeDir(), { recursive: true });
        yield fsp.mkdir(getDeckDir(), { recursive: true });
    });
}
export function hasFile(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const filePath = getFilePath({ hash: input.hash });
        try {
            yield fsp.access(filePath);
            return true;
        }
        catch (_a) {
            return false;
        }
    });
}
export function storeFile(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const filePath = getFilePath({ hash: input.hash });
        const dir = path.dirname(filePath);
        yield fsp.mkdir(dir, { recursive: true });
        const exists = yield hasFile({ hash: input.hash });
        if (!exists) {
            yield fsp.writeFile(filePath, input.data);
        }
        return filePath;
    });
}
export function storeDeckMeta(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const dir = path.join(getDeckDir(), 'link', input.registry, input.name, input.mark);
        yield fsp.mkdir(dir, { recursive: true });
        yield fsp.writeFile(path.join(dir, 'deck.tree'), input.data, 'utf-8');
    });
}
export function loadDeckMeta(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const file = path.join(getDeckDir(), 'link', input.registry, input.name, input.mark, 'deck.tree');
        try {
            return yield fsp.readFile(file, 'utf-8');
        }
        catch (_a) {
            return undefined;
        }
    });
}
export function pruneStore(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const treeDir = getTreeDir();
        let removed = 0;
        let bytes = 0;
        try {
            const prefixes = yield fsp.readdir(treeDir);
            for (const prefix of prefixes) {
                const prefixDir = path.join(treeDir, prefix);
                const stat = yield fsp.stat(prefixDir);
                if (!stat.isDirectory())
                    continue;
                const files = yield fsp.readdir(prefixDir);
                for (const file of files) {
                    if (!input.usedHashes.has(file)) {
                        const filePath = path.join(prefixDir, file);
                        const fileStat = yield fsp.stat(filePath);
                        bytes += fileStat.size;
                        yield fsp.unlink(filePath);
                        removed++;
                    }
                }
            }
        }
        catch (_a) {
            // store may not exist yet
        }
        return { removed, bytes };
    });
}
//# sourceMappingURL=store.js.map