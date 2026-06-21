// .tree code references packages without the `.tree` suffix,
// but on npm they are published with the `.tree` suffix.
// e.g. `@cluesurf/deck` in .tree code -> `@cluesurf/deck.tree` on npm

export function toRegistryName(input: { name: string }): string {
  if (input.name.endsWith('.tree')) return input.name
  return `${input.name}.tree`
}

export function toTreeName(input: { name: string }): string {
  if (input.name.endsWith('.tree')) {
    return input.name.slice(0, -5)
  }
  return input.name
}

export function isScoped(input: { name: string }): boolean {
  return input.name.startsWith('@')
}

export function parseScope(input: { name: string }): {
  scope: string
  base: string
} {
  if (!input.name.startsWith('@')) {
    return { scope: '', base: input.name }
  }
  const slashIndex = input.name.indexOf('/')
  if (slashIndex === -1) {
    return { scope: input.name, base: '' }
  }
  return {
    scope: input.name.slice(0, slashIndex),
    base: input.name.slice(slashIndex + 1),
  }
}
