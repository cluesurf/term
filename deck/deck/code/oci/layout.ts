// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/layout.ts's exports, with
// their shapes, answered by deck/deck/code/oci/image-layout.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-layout.
import * as port from '@term/deck/code/oci/image-layout'
import {
  liftRecord as lifted,
  ociErrorOf,
  type OciTransport,
} from './transport'

const p = port as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>

export const initLayout = async (dir: string): Promise<void> => {
  try {
    await (p.initLayout!(dir) as Promise<void>)
  } catch (error) {
    throw ociErrorOf(error)
  }
}

export const layoutTransport = (input: {
  dir: string
  prefix?: string
  bare?: boolean
}): OciTransport =>
  lifted(
    p.layoutTransport!(
      input.dir,
      input.prefix,
      input.bare,
    ) as OciTransport,
  )

// OWED, not a shape: deck/deck/code/index.ts (decision 153, its last importers waiting on 1044 and 1278) still
// re-exports this name, and an ES module that re-exports a name its source lacks fails to load. Artifact format v2
// keeps no object store (decision 129), so nothing on the install or publish path calls it; it refuses
export const layoutObjectStore = (_input: { dir: string }): never => {
  throw ociErrorOf(
    new Error(
      'OCI artifact format v2 keeps no object store (decision 129): a layout is reached through layoutTransport',
    ),
  )
}
