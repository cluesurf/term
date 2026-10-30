// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/name.ts had, with
// their shapes, answered by deck/deck/code/package/registry-naming.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
import * as port from '@term/deck/code/package/registry-naming'

export const TERM_REGISTRY: string = port.showTermRegistry()
export const DEFAULT_OCI_HOST: string = port.showDefaultOciHost()
export const DEFAULT_SCOPE_REGISTRIES: Record<string, string> =
  Object.fromEntries(port.defaultScopeRegistries())

export const toRegistryName = (input: { name: string }): string =>
  port.toRegistryName(input.name)
export const toTreeName = (input: { name: string }): string =>
  port.toTreeName(input.name)
export const isScoped = (input: { name: string }): boolean =>
  port.isScoped(input.name)
export const normalizeRegistry = (value: string): string =>
  port.normalizeRegistry(value)
export const parseScope = (input: {
  name: string
}): { scope: string; base: string } => port.parseScope(input.name)
export const scopeName = (word: string): string => port.scopeName(word)
export const rootScope = (scope: string): string =>
  port.rootScope(scope)

export function resolveRegistry(input: {
  name: string
  registry: string
  scopeRegistries?: Record<string, string>
}): string {
  return port.resolveRegistry(
    input.name,
    input.registry,
    new Map(Object.entries(input.scopeRegistries ?? {})),
  )
}
