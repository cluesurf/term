// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/need.ts's exports, with
// their shapes, answered by deck/deck/code/oci/toolchain-pin.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-need.
//
// toolchain-pin.tree reaches the registry through oci-routing.tree's transport, so a refusal from it is oci-failure
// (decision 007), raised here as the original's OciError.
import * as port from '@term/deck/code/oci/toolchain-pin'
import { ociErrorOf } from './transport'

async function liftAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw ociErrorOf(error)
  }
}

export const TOOLCHAIN = port.toolchain()
export const releasedVersions = (input: {
  transport: unknown
  repository: string
}): Promise<string[]> =>
  liftAsync(() =>
    port.releasedVersions(input.transport, input.repository),
  )
export const newestMatching = (input: {
  versions: string[]
  hold: unknown
}): string | undefined =>
  port.newestMatching(input.versions, input.hold) as string | undefined
export const pinSatisfies = (input: { need: any; pin: any }): boolean =>
  port.pinSatisfies(input.need, input.pin)
export const pinNeed = (input: {
  need: any
  previous?: any
  offline?: boolean
}): Promise<{ pin?: any; kept: boolean; reason?: string }> =>
  liftAsync(
    () =>
      port.pinNeed(
        input.need,
        input.previous,
        input.offline ?? false,
      ) as Promise<{ pin?: any; kept: boolean; reason?: string }>,
  )
export const showPin = (pin: any): string => port.showPin(pin)
