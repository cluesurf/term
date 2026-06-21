var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { parseMark } from './mark';
import { toRegistryName } from './name';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const CACHE_TTL_MS = 5 * 60 * 1000;
const metaCache = new Map();
export function makeDefaultFetchConfig() {
    return {
        registry: DEFAULT_REGISTRY,
        concurrency: 16,
        offline: false,
    };
}
export function fetchPackageMeta(input) {
    return __awaiter(this, void 0, void 0, function* () {
        if (input.config.offline) {
            throw new Error(`Cannot fetch ${input.name} in offline mode`);
        }
        const cached = metaCache.get(input.name);
        if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
            return cached.data;
        }
        const registryName = toRegistryName({ name: input.name });
        const url = `${input.config.registry}/${registryName}`;
        const response = yield fetch(url, {
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch ${input.name}: ${response.status} ${response.statusText}`);
        }
        const data = (yield response.json());
        metaCache.set(input.name, { data, time: Date.now() });
        return data;
    });
}
export function fetchTarball(input) {
    return __awaiter(this, void 0, void 0, function* () {
        if (input.config.offline) {
            throw new Error(`Cannot fetch tarball in offline mode: ${input.url}`);
        }
        const response = yield fetch(input.url);
        if (!response.ok) {
            throw new Error(`Failed to fetch tarball: ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = yield response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    });
}
export function getVersionList(input) {
    return Object.keys(input.meta.versions).map(v => parseMark(v));
}
export function getVersionMeta(input) {
    var _a;
    const entry = input.meta.versions[input.mark];
    if (!entry)
        return undefined;
    return {
        tarball: entry.dist.tarball,
        integrity: entry.dist.integrity,
        shasum: entry.dist.shasum,
        dependencies: (_a = entry.dependencies) !== null && _a !== void 0 ? _a : {},
    };
}
export function clearMetaCache() {
    metaCache.clear();
}
//# sourceMappingURL=fetch.js.map