// .tree code references packages without the `.tree` suffix,
// but on npm they are published with the `.tree` suffix.
// e.g. `@cluesurf/deck` in .tree code -> `@cluesurf/deck.tree` on npm
export function toRegistryName(input) {
    if (input.name.endsWith('.tree'))
        return input.name;
    return `${input.name}.tree`;
}
export function toTreeName(input) {
    if (input.name.endsWith('.tree')) {
        return input.name.slice(0, -5);
    }
    return input.name;
}
export function isScoped(input) {
    return input.name.startsWith('@');
}
export function parseScope(input) {
    if (!input.name.startsWith('@')) {
        return { scope: '', base: input.name };
    }
    const slashIndex = input.name.indexOf('/');
    if (slashIndex === -1) {
        return { scope: input.name, base: '' };
    }
    return {
        scope: input.name.slice(0, slashIndex),
        base: input.name.slice(slashIndex + 1),
    };
}
//# sourceMappingURL=name.js.map