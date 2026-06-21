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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadManifest } from './manifest';
import { showMark } from './mark';
import { fetchPackageMeta } from './fetch';
const execFileAsync = promisify(execFile);
const DEFAULT_INCLUDE = ['code', 'deck.tree', 'note.tree', 'book'];
const DEFAULT_EXCLUDE = [
    'link',
    'make',
    'hold',
    'test',
    'task',
    '.seed',
    'node_modules',
    '.git',
    'host',
];
const MAX_FILE_SIZE = 16 * 1024 * 1024;
const WARN_PACKAGE_SIZE = 10 * 1024 * 1024;
const MAX_PACKAGE_SIZE = 50 * 1024 * 1024;
export function collectFiles(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const files = [];
        // read .treeignore if exists
        const extraExclude = [];
        try {
            const ignoreText = yield fsp.readFile(path.join(input.dir, '.treeignore'), 'utf-8');
            for (const line of ignoreText.split('\n')) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    extraExclude.push(trimmed);
                }
            }
        }
        catch (_a) {
            // no .treeignore
        }
        const allExclude = [...DEFAULT_EXCLUDE, ...extraExclude];
        yield walkDir({
            base: input.dir,
            dir: input.dir,
            files,
            exclude: allExclude,
        });
        return files;
    });
}
function walkDir(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const entries = yield fsp.readdir(input.dir, {
            withFileTypes: true,
        });
        for (const entry of entries) {
            const fullPath = path.join(input.dir, entry.name);
            const relative = path.relative(input.base, fullPath);
            if (input.exclude.some(ex => relative.startsWith(ex)))
                continue;
            if (entry.name.startsWith('.'))
                continue;
            if (entry.isDirectory()) {
                yield walkDir({
                    base: input.base,
                    dir: fullPath,
                    files: input.files,
                    exclude: input.exclude,
                });
            }
            else if (entry.isFile()) {
                const stat = yield fsp.stat(fullPath);
                if (stat.size > MAX_FILE_SIZE) {
                    throw new Error(`File too large (${stat.size} bytes): ${relative}`);
                }
                input.files.push(relative);
            }
        }
    });
}
export function createTarball(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const manifest = yield loadManifest({ dir: input.dir });
        const markStr = showMark(manifest.mark);
        const tarName = `${manifest.name}-${markStr}.tgz`;
        const tmpDir = path.join(input.dir, '.seed', 'tmp');
        const packageDir = path.join(tmpDir, 'package');
        const tarPath = path.join(tmpDir, tarName);
        yield fsp.mkdir(packageDir, { recursive: true });
        // copy files to package/ directory
        for (const file of input.files) {
            const src = path.join(input.dir, file);
            const dst = path.join(packageDir, file);
            yield fsp.mkdir(path.dirname(dst), { recursive: true });
            yield fsp.copyFile(src, dst);
        }
        // create tarball
        yield execFileAsync('tar', ['czf', tarPath, '-C', tmpDir, 'package']);
        const tarball = yield fsp.readFile(tarPath);
        // cleanup
        yield fsp.rm(tmpDir, { recursive: true, force: true });
        if (tarball.length > MAX_PACKAGE_SIZE) {
            throw new Error(`Package too large: ${tarball.length} bytes (max ${MAX_PACKAGE_SIZE})`);
        }
        if (tarball.length > WARN_PACKAGE_SIZE) {
            console.warn(`Warning: package is ${tarball.length} bytes (above ${WARN_PACKAGE_SIZE} warning threshold)`);
        }
        return tarball;
    });
}
export function validateManifest(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const errors = [];
        if (!input.manifest.name) {
            errors.push('Missing package name');
        }
        if (input.manifest.mark.major === 0 &&
            input.manifest.mark.minor === 0 &&
            input.manifest.mark.patch === 0) {
            errors.push('Version must be set (not 0.0.0)');
        }
        if (input.manifest.mark.patch % 2 !== 0) {
            errors.push('Published versions must use even patch numbers');
        }
        return errors;
    });
}
export function publishDeck(input) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const manifest = yield loadManifest({ dir: input.dir });
        const markStr = showMark(manifest.mark);
        const fullName = manifest.host
            ? `@${manifest.host}/${manifest.name}`
            : manifest.name;
        // validate
        const errors = yield validateManifest({ manifest });
        if (errors.length > 0) {
            throw new Error(`Validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
        }
        // check if version already exists
        try {
            const meta = yield fetchPackageMeta({
                name: fullName,
                config: input.config,
            });
            if (meta.versions[markStr]) {
                throw new Error(`Version ${markStr} already published for ${fullName}`);
            }
        }
        catch (err) {
            // 404 means package doesn't exist yet, which is fine
            if (!((_a = err.message) === null || _a === void 0 ? void 0 : _a.includes('404'))) {
                throw err;
            }
        }
        // collect files
        const files = yield collectFiles({ dir: input.dir });
        console.log(`Files to publish (${files.length}):`);
        for (const file of files) {
            console.log(`  ${file}`);
        }
        // create tarball
        const tarball = yield createTarball({ dir: input.dir, files });
        console.log(`Package size: ${tarball.length} bytes`);
        if (input.dryRun) {
            console.log('Dry run complete. No upload.');
            return;
        }
        // upload to registry
        const url = `${input.config.registry}/${fullName}/-/${manifest.name}-${markStr}.tgz`;
        // read auth token
        const authToken = yield loadAuthToken();
        if (!authToken) {
            throw new Error('Not authenticated. Run `seed dock mind` to log in.');
        }
        const response = yield fetch(url, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/gzip',
            },
            body: new Uint8Array(tarball),
        });
        if (!response.ok) {
            throw new Error(`Publish failed: ${response.status} ${response.statusText}`);
        }
        console.log(`Published ${fullName}@${markStr}`);
    });
}
function loadAuthToken() {
    return __awaiter(this, void 0, void 0, function* () {
        const os = yield import('os');
        const authFile = path.join(os.homedir(), '.seed', 'auth');
        try {
            const text = yield fsp.readFile(authFile, 'utf-8');
            return text.trim();
        }
        catch (_a) {
            return undefined;
        }
    });
}
//# sourceMappingURL=publish.js.map