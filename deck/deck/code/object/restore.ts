// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/restore.ts's exports, with
// their shapes, answered by deck/deck/code/object/version-restore.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-restore.
import * as port from '@term/deck/code/object/version-restore'


export const safeJoin = (dest: string, at: string): string => port.safeJoin(dest, at)
export const restoreFiles = (input: { files: unknown[]; dest: string; store: unknown }): Promise<void> => port.restoreFiles(input.files, input.dest, input.store)
export const restoreVersion = (input: { root: string; dest: string; chunks: unknown; store: unknown }): Promise<never[]> =>
  port.restoreVersion(input.root, input.dest, input.chunks, input.store) as Promise<never[]>
