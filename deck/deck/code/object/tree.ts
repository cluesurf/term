// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/tree.ts's exports, with
// their shapes, answered by deck/deck/code/object/directory-node.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-tree.
import * as port from '@term/deck/code/object/directory-node'
import * as shape from '@term/deck/code/object/object-shape'


type TreeParams = { avgFanout: number; min: number; max: number }
type TreeEntry = { id: string; kind: 'blob' | 'tree'; mode: 'file' | 'exec' | 'dir'; name: string }

export const buildDirNode = (input: { entries: TreeEntry[]; store: unknown; params?: TreeParams }): Promise<string> =>
  port.buildDirNode(input.entries as never, input.store, input.params ?? shape.defaultTreeParams())

export const readDirEntries = (input: { nodeId: string; store: unknown }): Promise<TreeEntry[]> =>
  port.readDirEntries(input.nodeId, input.store) as Promise<TreeEntry[]>

export const dirNodeIds = (input: { nodeId: string; store: unknown; into: Set<string> }): Promise<void> =>
  port.dirNodeIds(input.nodeId, input.store, input.into)
