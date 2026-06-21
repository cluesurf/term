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
import { loadManifest } from './manifest';
export function findWorkspaces(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const workspaces = new Map();
        const deckDir = path.join(input.root, 'deck');
        try {
            yield fsp.access(deckDir);
        }
        catch (_a) {
            return workspaces;
        }
        yield scanForDecks({ dir: deckDir, workspaces });
        return workspaces;
    });
}
function scanForDecks(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const entries = yield fsp.readdir(input.dir, {
            withFileTypes: true,
        });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name === 'node_modules' || entry.name === 'link')
                continue;
            if (entry.name.startsWith('.'))
                continue;
            const subDir = path.join(input.dir, entry.name);
            const deckFile = path.join(subDir, 'deck.tree');
            try {
                yield fsp.access(deckFile);
                const manifest = yield loadManifest({ dir: subDir });
                const fullName = manifest.host
                    ? `@${manifest.host}/${manifest.name}`
                    : manifest.name;
                input.workspaces.set(fullName, manifest);
            }
            catch (_a) {
                // no deck.tree, scan deeper
                yield scanForDecks({ dir: subDir, workspaces: input.workspaces });
            }
        }
    });
}
export function findProjectRoot(input) {
    return __awaiter(this, void 0, void 0, function* () {
        let current = input.dir;
        while (true) {
            const deckFile = path.join(current, 'deck.tree');
            try {
                yield fsp.access(deckFile);
                return current;
            }
            catch (_a) {
                const parent = path.dirname(current);
                if (parent === current)
                    return undefined;
                current = parent;
            }
        }
    });
}
export function topologicalSort(input) {
    const graph = new Map();
    const allNames = new Set(input.workspaces.keys());
    for (const [name, manifest] of input.workspaces) {
        const deps = new Set();
        for (const link of manifest.link) {
            if (allNames.has(link.name)) {
                deps.add(link.name);
            }
        }
        graph.set(name, deps);
    }
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();
    function visit(name) {
        if (visited.has(name))
            return;
        if (visiting.has(name)) {
            console.warn(`Circular dependency detected: ${name}`);
            return;
        }
        visiting.add(name);
        const deps = graph.get(name);
        if (deps) {
            for (const dep of deps) {
                visit(dep);
            }
        }
        visiting.delete(name);
        visited.add(name);
        sorted.push(name);
    }
    for (const name of allNames) {
        visit(name);
    }
    return sorted;
}
//# sourceMappingURL=workspace.js.map