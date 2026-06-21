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
import { showMark } from './mark';
import { getFilePath, initStore } from './store';
import { hashBuffer } from './hash';
import { fetchTarball } from './fetch';
const LINK_DIR = 'link';
const SEED_DIR = '.seed';
export function linkPackages(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const linkDir = path.join(input.root, LINK_DIR);
        const seedDir = path.join(linkDir, SEED_DIR);
        yield fsp.mkdir(linkDir, { recursive: true });
        yield fsp.mkdir(seedDir, { recursive: true });
        yield initStore();
        // install each resolved package to the flat store
        const tasks = [];
        const chunks = chunkArray(Array.from(input.resolution.decks.values()), input.config.concurrency);
        for (const chunk of chunks) {
            const chunkTasks = chunk.map(resolved => installResolved({
                resolved,
                seedDir,
                config: input.config,
            }));
            yield Promise.all(chunkTasks);
        }
        // create top-level symlinks for direct dependencies
        for (const resolved of input.resolution.decks.values()) {
            yield createTopLink({
                linkDir,
                seedDir,
                resolved,
            });
        }
        // create per-package dependency symlinks
        for (const resolved of input.resolution.decks.values()) {
            yield createDepLinks({
                seedDir,
                resolved,
                resolution: input.resolution,
            });
        }
    });
}
function installResolved(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const { resolved, seedDir } = input;
        const markStr = showMark(resolved.mark);
        const deckDir = path.join(seedDir, `${resolved.name}@${markStr}`);
        // skip if already installed
        try {
            yield fsp.access(deckDir);
            return;
        }
        catch (_a) {
            // not installed yet
        }
        // skip workspace packages (no tarball)
        if (!resolved.site)
            return;
        // fetch tarball
        const tarball = yield fetchTarball({
            url: resolved.site,
            config: input.config,
        });
        // verify integrity
        if (resolved.hash) {
            const expected = resolved.hash.replace(/^sha512-/, '');
            const actual = yield hashBuffer({ data: tarball });
            // npm uses base64-encoded sha512, we use hex
            // try hex comparison first, then base64
            const actualBase64 = tarball.length > 0
                ? (yield import('crypto')).createHash('sha512').update(tarball).digest('base64')
                : '';
            if (actual !== expected && actualBase64 !== expected) {
                throw new Error(`Integrity check failed for ${resolved.name}@${showMark(resolved.mark)}. ` +
                    `Expected ${expected}, got ${actual}`);
            }
        }
        // extract tarball to store and hard-link to package dir
        yield extractAndLink({
            tarball,
            deckDir,
        });
    });
}
function extractAndLink(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const { tarball, deckDir } = input;
        yield fsp.mkdir(deckDir, { recursive: true });
        // use tar to extract (Node.js built-in via child_process)
        const { execFile } = yield import('child_process');
        const { promisify } = yield import('util');
        const execFileAsync = promisify(execFile);
        // write tarball to temp file
        const tmpFile = `${deckDir}.tgz`;
        yield fsp.writeFile(tmpFile, tarball);
        try {
            yield execFileAsync('tar', [
                'xzf',
                tmpFile,
                '-C',
                deckDir,
                '--strip-components=1',
            ]);
        }
        finally {
            yield fsp.unlink(tmpFile).catch(() => { });
        }
        // hard-link files to content-addressed store
        yield hardLinkToStore({ dir: deckDir });
    });
}
function hardLinkToStore(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const entries = yield fsp.readdir(input.dir, {
            withFileTypes: true,
        });
        for (const entry of entries) {
            const fullPath = path.join(input.dir, entry.name);
            if (entry.isDirectory()) {
                yield hardLinkToStore({ dir: fullPath });
                continue;
            }
            if (entry.isFile()) {
                const data = yield fsp.readFile(fullPath);
                const hash = yield hashBuffer({ data });
                const storePath = getFilePath({ hash });
                const storeDir = path.dirname(storePath);
                yield fsp.mkdir(storeDir, { recursive: true });
                try {
                    yield fsp.access(storePath);
                }
                catch (_a) {
                    // file not in store yet, move it there
                    yield fsp.writeFile(storePath, data);
                }
                // replace original with hard link
                yield fsp.unlink(fullPath);
                yield fsp.link(storePath, fullPath);
            }
        }
    });
}
function createTopLink(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const { linkDir, seedDir, resolved } = input;
        const markStr = showMark(resolved.mark);
        const deckDir = path.join(seedDir, `${resolved.name}@${markStr}`);
        // parse scope from name
        const parts = resolved.name.split('/');
        let targetLink;
        if (parts.length === 2) {
            // scoped: @scope/name -> link/@scope/name
            const scopeDir = path.join(linkDir, parts[0]);
            yield fsp.mkdir(scopeDir, { recursive: true });
            targetLink = path.join(scopeDir, parts[1]);
        }
        else {
            targetLink = path.join(linkDir, resolved.name);
        }
        // remove existing symlink
        yield fsp.rm(targetLink, { force: true });
        // create relative symlink
        const relative = path.relative(path.dirname(targetLink), deckDir);
        yield fsp.symlink(relative, targetLink);
    });
}
function createDepLinks(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const { seedDir, resolved, resolution } = input;
        const markStr = showMark(resolved.mark);
        const deckDir = path.join(seedDir, `${resolved.name}@${markStr}`);
        const depsLinkDir = path.join(deckDir, LINK_DIR);
        if (resolved.link.size === 0)
            return;
        yield fsp.mkdir(depsLinkDir, { recursive: true });
        for (const [depName] of resolved.link) {
            // find the resolved version of this dependency
            const depResolved = findResolvedDep({
                name: depName,
                resolution,
            });
            if (!depResolved)
                continue;
            const depMarkStr = showMark(depResolved.mark);
            const depDeckDir = path.join(seedDir, `${depName}@${depMarkStr}`);
            // parse scope
            const parts = depName.split('/');
            let targetLink;
            if (parts.length === 2) {
                const scopeDir = path.join(depsLinkDir, parts[0]);
                yield fsp.mkdir(scopeDir, { recursive: true });
                targetLink = path.join(scopeDir, parts[1]);
            }
            else {
                targetLink = path.join(depsLinkDir, depName);
            }
            yield fsp.rm(targetLink, { force: true });
            const relative = path.relative(path.dirname(targetLink), depDeckDir);
            yield fsp.symlink(relative, targetLink);
        }
    });
}
function findResolvedDep(input) {
    for (const resolved of input.resolution.decks.values()) {
        if (resolved.name === input.name) {
            return resolved;
        }
    }
    return undefined;
}
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}
export function cleanLinks(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const linkDir = path.join(input.root, LINK_DIR);
        yield fsp.rm(linkDir, { recursive: true, force: true });
    });
}
export function devLink(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const { loadManifest } = yield import('./manifest');
        const manifest = yield loadManifest({ dir: input.packageDir });
        const fullName = manifest.host
            ? `@${manifest.host}/${manifest.name}`
            : manifest.name;
        const linkDir = path.join(input.root, LINK_DIR);
        const parts = fullName.split('/');
        let targetLink;
        if (parts.length === 2) {
            const scopeDir = path.join(linkDir, parts[0]);
            yield fsp.mkdir(scopeDir, { recursive: true });
            targetLink = path.join(scopeDir, parts[1]);
        }
        else {
            yield fsp.mkdir(linkDir, { recursive: true });
            targetLink = path.join(linkDir, fullName);
        }
        yield fsp.rm(targetLink, { force: true });
        yield fsp.symlink(path.resolve(input.packageDir), targetLink);
    });
}
export function devUnlink(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const linkDir = path.join(input.root, LINK_DIR);
        const parts = input.name.split('/');
        let targetLink;
        if (parts.length === 2) {
            targetLink = path.join(linkDir, parts[0], parts[1]);
        }
        else {
            targetLink = path.join(linkDir, input.name);
        }
        yield fsp.rm(targetLink, { force: true });
    });
}
//# sourceMappingURL=link.js.map