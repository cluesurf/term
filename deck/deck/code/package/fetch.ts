// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/fetch.ts had, with
// their shapes, answered by deck/deck/code/package/registry-fetching.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
import type { Code, FetchConfig, RegistryPackageMeta } from '@term/deck/code/form'
import * as port from '@term/deck/code/package/registry-fetching'
import { refused, refusedNow } from './grammars'
import { code } from './manifest'

// the routes as the port holds them: a hash, from the caller's object (or a Map a port handed on)
function toPort(config: FetchConfig): unknown {
  const routes = config.scopeRegistries as unknown

  return { ...config, scopeRegistries: routes instanceof Map ? routes : new Map(Object.entries((routes as Record<string, string>) ?? {})) }
}

export function makeDefaultFetchConfig(): FetchConfig {
  const config = port.makeDefaultFetchConfig() as { scopeRegistries: Map<string, string> }

  return { ...config, scopeRegistries: Object.fromEntries(config.scopeRegistries) } as FetchConfig
}

export async function fetchPackageMeta(input: { name: string; config: FetchConfig }): Promise<RegistryPackageMeta> {
  return (await refused(() => port.fetchPackageMeta(input.name, toPort(input.config) as never))) as RegistryPackageMeta
}

export async function fetchTarball(input: { url: string; config: FetchConfig }): Promise<Buffer> {
  return (await refused(() => port.fetchTarball(input.url, toPort(input.config) as never))) as Buffer
}

export function getVersionList(input: { meta: RegistryPackageMeta }): Code[] {
  return (refusedNow(() => port.getVersionList(input.meta)) as never[]).map(c => code(c))
}

export function getVersionMeta(input: { meta: RegistryPackageMeta; code: string }):
  | { tarball: string; integrity: string; shasum: string; dependencies: Record<string, string> }
  | undefined {
  const found = port.getVersionMeta(input.meta, input.code) as { form: string; value?: { tarball: string; integrity: string; shasum: string; dependencies: Map<string, string> } }

  return found.form === 'some' ? { ...found.value!, dependencies: Object.fromEntries(found.value!.dependencies) } : undefined
}

export function clearMetaCache(): void {
  port.clearMetaCache()
}
