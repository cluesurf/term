// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/manifest.ts had, with
// their shapes, answered by deck/deck/code/package/manifest-reading.tree, manifest-text.tree and spelling.tree. The
// logic is Term; this file only converts shapes for TypeScript callers.
import { DeckManifest, CodeHold, Code } from '@term/deck/code/form'
import * as reading from '@term/deck/code/package/manifest-reading'
import * as text from '@term/deck/code/package/manifest-text'
import * as spelling from '@term/deck/code/package/spelling'
import { GRAMMARS, refused, refusedNow } from './grammars'

type PortCode = {
  major: number
  minor: number
  patch: number
  prerelease: string
  build: string
}
type PortHold = { form: string; [key: string]: unknown }

export function code(port: PortCode): Code {
  return {
    major: port.major,
    minor: port.minor,
    patch: port.patch,
    prerelease: port.prerelease === '' ? undefined : port.prerelease,
    ...(port.build !== '' ? { build: port.build } : {}),
  }
}

function hold(port: PortHold): CodeHold {
  switch (port.form) {
    case 'exact':
      return { form: 'exact', code: code(port.code as PortCode) }
    case 'wild':
      return {
        form: 'wild',
        major: port.major as number,
        ...((port.minor as number) >= 0
          ? { minor: port.minor as number }
          : {}),
        ...((port.patch as number) >= 0
          ? { patch: port.patch as number }
          : {}),
      }
    case 'band':
      return {
        form: 'band',
        base: code(port.base as PortCode),
        head: code(port.head as PortCode),
      }
    default:
      return {
        form: 'test',
        list: (port.list as PortHold[]).map(hold) as never,
      }
  }
}

type PortLink = { name: string; mark: PortHold; have?: number }
const link = (port: PortLink) => ({ ...port, mark: hold(port.mark) })

export function fromPort(port: Record<string, unknown>): DeckManifest {
  const out: Record<string, unknown> = {
    ...port,
    mark: code(port.mark as PortCode),
    link: (port.link as PortLink[]).map(link),
  }

  if (port.devLink) {out.devLink = (port.devLink as PortLink[]).map(link)}

  if (port.hostLink)
    {out.hostLink = (
      port.hostLink as { registry: string; link: PortLink[] }[]
    ).map(g => ({ ...g, link: g.link.map(link) }))}

  if (port.need)
    {out.need = {
      ...(port.need as object),
      mark: hold((port.need as { mark: PortHold }).mark),
    }}

  if (port.hook instanceof Map) {out.hook = Object.fromEntries(port.hook)}

  return out as DeckManifest
}

function toPort(manifest: DeckManifest): unknown {
  const shaped = portManifest(manifest as never) as Record<
    string,
    unknown
  >

  if (manifest.hook !== undefined) {
    shaped.hook = new Map(Object.entries(manifest.hook))
  }

  return shaped
}

export async function loadManifest(input: {
  dir: string
}): Promise<DeckManifest> {
  return fromPort(
    (await refused(() =>
      reading.loadManifest(input.dir, GRAMMARS),
    )) as never,
  )
}

export function parseManifest(input: { text: string }): DeckManifest {
  return fromPort(
    refusedNow(() =>
      reading.parseManifest(input.text, GRAMMARS),
    ) as never,
  )
}

export function parseManifestByHand(input: {
  text: string
}): DeckManifest {
  return fromPort(
    refusedNow(() => reading.parseManifestByHand(input.text)) as never,
  )
}

export function writeManifest(input: {
  manifest: DeckManifest
}): string {
  return text.writeManifest(toPort(input.manifest) as never)
}

export function writeCodeHold(input: { hold: CodeHold }): string {
  const shaped = portManifest({
    host: '',
    name: '',
    mark: { major: 0, minor: 0, patch: 0 },
    link: [{ name: 'x', mark: input.hold }],
  }) as { link: { mark: unknown }[] }

  return text.writeCodeHold(shaped.link[0]!.mark as never)
}

export async function validateManifest(input: {
  manifest: DeckManifest
}): Promise<string[]> {
  return reading.validateManifest(toPort(input.manifest) as never)
}

export function isDefaultCodeRoot(value: string): boolean {
  return reading.isDefaultCodeRoot(value)
}

export const DEFAULT_BOOK_ROOT = reading.defaultBookRoot()

export function bookRoot(manifest: { book?: string }): string {
  return reading.bookRoot({ book: manifest.book } as never)
}

export type ManifestSpelling = {
  rule: 'manifest-code-version' | 'manifest-bear'
  message: string
  line: number
  column: number
  end: number
  text: string
  wholeLine?: boolean
}

export function manifestSpellings(input: {
  text: string
  file?: string
}): ManifestSpelling[] {
  return spelling.manifestSpellings(
    input.text,
    input.file,
  ) as ManifestSpelling[]
}

export function rewriteManifestSpellings(input: {
  text: string
  file?: string
}): { text: string; changes: ManifestSpelling[] } {
  return spelling.rewriteManifestSpellings(
    input.text,
    input.file,
  ) as never
}

// ---- the original's shapes into the port's (carried from tmp/self-host/pairs/package-reading.ts) ----

type AnyCode = {
  major: number
  minor: number
  patch: number
  prerelease?: string
  build?: string
}
type AnyHold = { form: string; [key: string]: unknown }

function portCode(value: AnyCode): AnyCode {
  return {
    major: value.major,
    minor: value.minor,
    patch: value.patch,
    prerelease: value.prerelease ?? '',
    build: value.build ?? '',
  }
}

function portHold(value: AnyHold): AnyHold {
  switch (value.form) {
    case 'exact':
      return { form: 'exact', code: portCode(value.code as AnyCode) }
    case 'wild':
      return {
        form: 'wild',
        major: value.major,
        minor: (value.minor as number | undefined) ?? -1,
        patch: (value.patch as number | undefined) ?? -1,
      }
    case 'band':
      return {
        form: 'band',
        base: portCode(value.base as AnyCode),
        head: portCode(value.head as AnyCode),
      }
    default:
      return {
        form: 'test',
        list: (value.list as AnyHold[]).map(portHold),
      }
  }
}

type AnyLink = { name: string; mark: AnyHold; have?: number }

const portLink = (value: AnyLink): AnyLink => ({
  ...value,
  mark: portHold(value.mark),
})

/** The original's manifest in the port's shape (an undefined field is no field). */
export function portManifest(
  manifest: Record<string, unknown>,
): unknown {
  const out: Record<string, unknown> = {
    ...manifest,
    mark: portCode(manifest.mark as AnyCode),
    link: (manifest.link as AnyLink[]).map(portLink),
  }

  if (manifest.devLink) {
    out.devLink = (manifest.devLink as AnyLink[]).map(portLink)
  }

  if (manifest.hostLink) {
    out.hostLink = (
      manifest.hostLink as { registry: string; link: AnyLink[] }[]
    ).map(group => ({ ...group, link: group.link.map(portLink) }))
  }

  if (manifest.need) {
    const need = manifest.need as { name: string; mark: AnyHold }
    out.need = { ...need, mark: portHold(need.mark) }
  }

  return JSON.parse(JSON.stringify(out))
}
