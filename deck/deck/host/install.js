var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { loadManifest, writeManifest } from './manifest';
import { loadLockfile, saveLockfile } from './lock';
import { resolve, buildLockfile } from './resolve';
import { linkPackages, cleanLinks } from './link';
import { makeDefaultFetchConfig } from './fetch';
import { findWorkspaces } from './workspace';
import { parseMarkHold, showMark } from './mark';
import { initStore } from './store';
import fsp from 'fs/promises';
import path from 'path';
export function install(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const config = makeDefaultFetchConfig();
        if (input.offline) {
            config.offline = true;
        }
        yield initStore();
        // step 1: read manifest
        const manifest = yield loadManifest({ dir: input.root });
        // step 2: discover workspaces
        const workspaces = yield findWorkspaces({ root: input.root });
        // step 3: read lockfile
        const lockfile = yield loadLockfile({ dir: input.root });
        // step 4: clean if requested
        if (input.clean) {
            yield cleanLinks({ root: input.root });
        }
        // step 5: resolve dependencies
        const resolution = yield resolve({
            manifest,
            config,
            lockfile: lockfile !== null && lockfile !== void 0 ? lockfile : undefined,
            workspaces,
        });
        // step 6: link packages
        yield linkPackages({
            root: input.root,
            resolution,
            config,
        });
        // step 7: write lockfile
        const newLockfile = buildLockfile({ resolution });
        yield saveLockfile({ dir: input.root, lockfile: newLockfile });
        console.log(`Installed ${resolution.decks.size} packages`);
    });
}
export function addDependency(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const manifest = yield loadManifest({ dir: input.root });
        const hold = input.constraint
            ? parseMarkHold(input.constraint)
            : { form: 'wild', major: 0 };
        // check if already exists
        const existing = manifest.link.findIndex(l => l.name === input.name);
        if (existing >= 0) {
            manifest.link[existing] = { name: input.name, mark: hold };
        }
        else {
            manifest.link.push({ name: input.name, mark: hold });
        }
        // write updated manifest
        const text = writeManifest({ manifest });
        yield fsp.writeFile(path.join(input.root, 'deck.tree'), text, 'utf-8');
        // re-install
        yield install({ root: input.root });
    });
}
export function removeDependency(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const manifest = yield loadManifest({ dir: input.root });
        manifest.link = manifest.link.filter(l => l.name !== input.name);
        // write updated manifest
        const text = writeManifest({ manifest });
        yield fsp.writeFile(path.join(input.root, 'deck.tree'), text, 'utf-8');
        // re-install
        yield install({ root: input.root });
    });
}
export function verifyInstall(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const lockfile = yield loadLockfile({ dir: input.root });
        if (!lockfile) {
            return { ok: false, missing: ['lock.tree not found'], outdated: [] };
        }
        const missing = [];
        const outdated = [];
        for (const entry of lockfile.decks) {
            const markStr = showMark(entry.mark);
            const linkPath = path.join(input.root, 'link', '.seed', `${entry.name}@${markStr}`);
            try {
                yield fsp.access(linkPath);
            }
            catch (_a) {
                missing.push(`${entry.name}@${markStr}`);
            }
        }
        return {
            ok: missing.length === 0 && outdated.length === 0,
            missing,
            outdated,
        };
    });
}
//# sourceMappingURL=install.js.map