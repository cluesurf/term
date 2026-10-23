// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/model.ts's exports, with
// their shapes, answered by deck/deck/code/object/object-shape.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-model.
import * as port from '@term/deck/code/object/object-shape'


export type EntryMode = 'file' | 'exec' | 'dir'
export type Blob = { chunks: string[]; size: number }
export type TreeEntry = { id: string; kind: 'blob' | 'tree'; mode: EntryMode; name: string }
export type NodeRef = { id: string; key: string }
export type LeafNode = { entries: TreeEntry[]; level: 0 }
export type InnerNode = { level: number; refs: NodeRef[] }
export type TreeNode = LeafNode | InnerNode
export type Commit = { author: string; deps: Record<string, string>; manifest: string; message: string; package: string; parents: string[]; time: string; tree: string }
export type TreeParams = { avgFanout: number; min: number; max: number }

function orNull(found: { form: string; value?: string }): string | null {
  return found.form === 'some' ? found.value! : null
}

export const isLeafNode = (node: TreeNode): node is LeafNode => port.isLeafNode(node)
export const canonicalJson = (value: unknown): string => port.canonicalJson(value)
export const chunkId = (bytes: Buffer): string => port.chunkId(bytes)
export const blobId = (blob: Blob): string => port.blobId(blob)
export const nodeId = (node: TreeNode): string => port.nodeId(node)
export const commitId = (commit: Commit): string => port.commitId(commit)
export const sortEntries = (entries: TreeEntry[]): TreeEntry[] => port.sortEntries(entries as never) as TreeEntry[]
export const DEFAULT_TREE_PARAMS: TreeParams = port.defaultTreeParams()
export const idNumber = (id: string): number => port.idNumber(id)
export const isNodeBoundary = (id: string, avgFanout: number): boolean => port.isNodeBoundary(id, avgFanout)
export const validateEntryName = (name: string): string | null => orNull(port.validateEntryName(name))
export const validateEntries = (entries: TreeEntry[]): string | null => orNull(port.validateEntries(entries as never))
