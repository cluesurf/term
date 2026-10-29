// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/workspace.ts had, with
// their shapes, answered by deck/deck/code/package/workspace-finding.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
import type { DeckManifest } from '@term/deck/code/form'
import * as port from '@term/deck/code/package/workspace-finding'
import { GRAMMARS, refused } from './grammars'
import { fromPort } from './manifest'

export type Workspace = DeckManifest & { dir: string }

// the folder is a `like maybe` field with `need false`, stored bare (self-host traps T002)
type PortWorkspace = { manifest: Record<string, unknown>; dir: string }

export async function findWorkspaces(input: {
  root: string
}): Promise<Map<string, Workspace>> {
  const found = (await refused(() =>
    port.findWorkspaces(input.root, GRAMMARS),
  )) as Map<string, PortWorkspace>

  const out = new Map<string, Workspace>()

  for (const [name, deck] of found) {
    out.set(name, { ...fromPort(deck.manifest), dir: deck.dir })
  }

  return out
}

export async function findProjectRoot(input: {
  dir: string
}): Promise<string | undefined> {
  const found = (await port.findProjectRoot(input.dir)) as {
    form: string
    value?: string
  }

  return found.form === 'some' ? found.value : undefined
}

export function topologicalSort(input: {
  workspaces: Map<string, DeckManifest>
}): string[] {
  // the sort reads a manifest's links' names alone, so a caller's partial manifest (the suite's fixtures carry no
  // version) passes through as it is
  return port.topologicalSort(
    new Map(
      [...input.workspaces].map(([name, manifest]) => [
        name,
        manifest as never,
      ]),
    ),
  )
}
