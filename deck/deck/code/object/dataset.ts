// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/dataset.ts's exports, with
// their shapes, answered by deck/deck/code/object/file-dataset.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-dataset.
import * as port from '@term/deck/code/object/file-dataset'


export type PackageFile = { path: string; mode: 'file' | 'exec' | 'dir'; size: number; chunks: string[]; record?: never }

export const FILE_TYPE: string = port.fileType()
export const TREE_TYPE: string = port.treeType()

export const markOfPath = (path: string): string => port.markOfPath(path)
export const fileRecord = (file: PackageFile): never => port.fileRecord(file) as never
export const datasetOfFiles = (files: Iterable<PackageFile>): Map<string, never> => port.datasetOfFiles([...files]) as never
export const fileOfRecord = (record: unknown): PackageFile | undefined => port.fileOfRecord(record) as PackageFile | undefined
export const filesOfDataset = (dataset: unknown): PackageFile[] => port.filesOfDataset(dataset) as PackageFile[]
