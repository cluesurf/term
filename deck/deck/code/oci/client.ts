// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/client.ts's exports, with
// their shapes, answered by deck/deck/code/oci/oci-routing.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-client.
//
// oci-routing.tree loads image-layout.tree and registry-transport.tree, so a transport or store it makes raises
// oci-failure (decision 007); each is handed to a TypeScript caller lifted, its failures the original's OciError.
import * as port from '@term/deck/code/oci/oci-routing'
import { liftRecord, ociErrorOf } from './transport'

export type OciRoute = {
  registry: any
  repository: any
  scope: string
  keysRepository: string
}

export const KEYS_REPOSITORY = port.keysRepository()
export const storeDir = (): string => port.storeDir()
export const trustDir = (): string => port.trustDir()
export const localStore = (): any =>
  liftRecord(port.localStore() as object)
export const storeTransport = (host: string): any =>
  liftRecord(port.storeTransport(host) as object)
export const transportFor = (input: {
  host: string
  offline?: boolean
}): any =>
  liftRecord(
    port.transportFor(input.host, input.offline ?? false) as object,
  )

export const ociRouteOf = (input: {
  name: string
  config: unknown
}): OciRoute | undefined => {
  try {
    return port.ociRouteOf(input.name, input.config) as
      | OciRoute
      | undefined
  } catch (error) {
    throw ociErrorOf(error)
  }
}
