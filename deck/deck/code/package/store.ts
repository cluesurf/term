// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/store.ts had, with
// their shapes, answered by deck/deck/code/package/file-store.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
import * as port from '@term/deck/code/package/file-store'

export const getStoreRoot = (): string => port.getStoreRoot()
export const getBaseDir = (): string => port.getBaseDir()
export const getTreeDir = (): string => port.getTreeDir()
export const getDeckDir = (): string => port.getDeckDir()
export const getFilePath = (input: { hash: string }): string =>
  port.getFilePath(input.hash)
export const initStore = async (): Promise<void> => port.initStore()
export const hasFile = async (input: {
  hash: string
}): Promise<boolean> => port.hasFile(input.hash)
export const storeFile = async (input: {
  data: Buffer
  hash: string
}): Promise<string> => port.storeFile(input.data, input.hash)

export async function storeDeckMeta(input: {
  registry: string
  name: string
  code: string
  data: string
}): Promise<void> {
  await port.storeDeckMeta(
    input.registry,
    input.name,
    input.code,
    input.data,
  )
}

export async function loadDeckMeta(input: {
  registry: string
  name: string
  code: string
}): Promise<string | undefined> {
  const found = (await port.loadDeckMeta(
    input.registry,
    input.name,
    input.code,
  )) as { form: string; value?: string }

  return found.form === 'some' ? found.value : undefined
}

export async function pruneStore(input: {
  usedHashes: Set<string>
}): Promise<{ removed: number; bytes: number }> {
  return port.pruneStore([...input.usedHashes])
}
