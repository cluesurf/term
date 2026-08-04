import { FetchConfig, Code, RegistryPackageMeta } from './form'
import { parseCode } from './code'
import { resolveRegistry, DEFAULT_SCOPE_REGISTRIES } from './name'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const CACHE_TTL_MS = 5 * 60 * 1000

const metaCache = new Map<
  string,
  { data: RegistryPackageMeta; time: number }
>()

export function makeDefaultFetchConfig(): FetchConfig {
  return {
    registry: DEFAULT_REGISTRY,
    scopeRegistries: { ...DEFAULT_SCOPE_REGISTRIES },
    concurrency: 16,
    offline: false,
  }
}

export async function fetchPackageMeta(input: {
  name: string
  config: FetchConfig
}): Promise<RegistryPackageMeta> {
  if (input.config.offline) {
    throw new Error(`Cannot fetch ${input.name} in offline mode`)
  }

  const cached = metaCache.get(input.name)

  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return cached.data
  }

  const registry = resolveRegistry({
    name: input.name,
    registry: input.config.registry,
    scopeRegistries: input.config.scopeRegistries,
  })
  // native scoped name, no `.tree` suffix: `${registry}/@term/base`
  const url = `${registry}/${input.name}`
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${input.name}: ` +
        `${response.status} ${response.statusText}\n  GET ${url}` +
        (await readErrorBody(response)),
    )
  }

  const data = (await response.json()) as RegistryPackageMeta

  metaCache.set(input.name, { data, time: Date.now() })

  return data
}

export async function fetchTarball(input: {
  url: string
  config: FetchConfig
}): Promise<Buffer> {
  if (input.config.offline) {
    throw new Error(
      `Cannot fetch tarball in offline mode: ${input.url}`,
    )
  }

  const response = await fetch(input.url)

  if (!response.ok) {
    throw new Error(
      `Failed to fetch tarball: ` +
        `${response.status} ${response.statusText}\n  GET ${input.url}` +
        (await readErrorBody(response)),
    )
  }

  const arrayBuffer = await response.arrayBuffer()

  return Buffer.from(arrayBuffer)
}

// Read a failed response's body (truncated) so network errors carry the
// server's explanation, not just the status line. Never throws.
async function readErrorBody(response: Response): Promise<string> {
  try {
    const body = await response.text()

    return body ? `\n  response: ${body.slice(0, 1000)}` : ''
  } catch {
    return ''
  }
}

export function getVersionList(input: {
  meta: RegistryPackageMeta
}): Code[] {
  return Object.keys(input.meta.versions).map(v => parseCode(v))
}

export function getVersionMeta(input: {
  meta: RegistryPackageMeta
  code: string
}):
  | {
      tarball: string
      integrity: string
      shasum: string
      dependencies: Record<string, string>
    }
  | undefined {
  const entry = input.meta.versions[input.code]

  if (!entry) {return undefined}

  return {
    tarball: entry.dist.tarball,
    integrity: entry.dist.integrity,
    shasum: entry.dist.shasum,
    dependencies: entry.dependencies ?? {},
  }
}

export function clearMetaCache(): void {
  metaCache.clear()
}
