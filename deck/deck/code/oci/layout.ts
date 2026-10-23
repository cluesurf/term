// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/layout.ts's exports, with
// their shapes, answered by deck/deck/code/oci/image-layout.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-layout.
import * as port from '@term/deck/code/oci/image-layout'
import { liftRecord as lifted, ociErrorOf, type OciTransport } from './transport'
import type { ObjectStore } from '../object/store'

const p = port as unknown as Record<string, (...args: unknown[]) => unknown>

export const initLayout = async (dir: string): Promise<void> => {
  try {
    await (p.initLayout!(dir) as Promise<void>)
  } catch (error) {
    throw ociErrorOf(error)
  }
}

export const layoutTransport = (input: { dir: string; prefix?: string; bare?: boolean }): OciTransport =>
  lifted(p.layoutTransport!(input.dir, input.prefix, input.bare) as OciTransport)

export const layoutObjectStore = (input: { dir: string }): ObjectStore => lifted(p.layoutObjectStore!(input.dir) as ObjectStore)
