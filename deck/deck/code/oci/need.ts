// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/need.ts's exports, with
// their shapes, answered by deck/deck/code/oci/toolchain-pin.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-need.
//
// toolchain-pin.tree reaches the registry through oci-routing.tree's transport, so a refusal from it is oci-failure
// (decision 007), raised here as the original's OciError. pin-need and pin-satisfies take a need and a maybe of a pin
// in version.tree's shapes (term-self-host-001-1402): a caller's code or hold may leave a part out, so each is read
// into the port's shape here, and a kept pin comes back as the caller's own.
import * as port from '@term/deck/code/oci/toolchain-pin'
import { ociErrorOf } from './transport'

type AnyCode = {
  major: number
  minor: number
  patch: number
  prerelease?: string
  build?: string
}
type AnyHold = { form: string; [key: string]: any }

async function liftAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw ociErrorOf(error)
  }
}

// a code in version.tree's shape, a part the caller left out written as nothing
const portCode = (value: AnyCode) => ({
  major: value.major,
  minor: value.minor,
  patch: value.patch,
  prerelease: value.prerelease ?? '',
  build: value.build ?? '',
})

// a hold in version.tree's shape, a wildcard's open part `-1`
const portHold = (hold: AnyHold): AnyHold =>
  hold.form === 'exact'
    ? { form: 'exact', code: portCode(hold.code) }
    : hold.form === 'wild'
      ? {
          form: 'wild',
          major: hold.major,
          minor: hold.minor ?? -1,
          patch: hold.patch ?? -1,
        }
      : hold.form === 'band'
        ? {
            form: 'band',
            base: portCode(hold.base),
            head: portCode(hold.head),
          }
        : { form: 'test', list: hold.list.map(portHold) }

const portNeed = (need: any) => ({ ...need, mark: portHold(need.mark) })

const portPin = (pin: any) =>
  pin
    ? { form: 'some', value: { ...pin, code: portCode(pin.code) } }
    : { form: 'none' }

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
  port.pinSatisfies(
    portNeed(input.need) as never,
    portPin(input.pin) as never,
  )
export const pinNeed = async (input: {
  need: any
  previous?: any
  offline?: boolean
}): Promise<{ pin?: any; kept: boolean; reason?: string }> => {
  const answer = (await liftAsync(() =>
    port.pinNeed(
      portNeed(input.need) as never,
      portPin(input.previous) as never,
      input.offline ?? false,
    ),
  )) as { pin?: any; kept: boolean; reason?: string }

  // a kept pin is the caller's own previous pin, in the caller's shape; a new one carries version.tree's code
  return answer.kept ? { ...answer, pin: input.previous } : answer
}
export const showPin = (pin: any): string => port.showPin(pin)
