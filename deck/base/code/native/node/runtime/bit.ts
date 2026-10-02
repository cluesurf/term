// Bitwise integer operations over the node host, 64-bit like the compiled backends: each op runs
// through BigInt and truncates back to a signed 64-bit value, so a mask such as 0xffffffff is a
// mask and not the JavaScript 32-bit coercion to -1. The result rides a plain number, so it is
// exact within the 53-bit safe-integer range (the same bound every number on this host lives
// under). Reached only through the public bit API.
const bit = {
  and: (left: number, right: number): number =>
    Number(
      BigInt.asIntN(
        64,
        BigInt(Math.trunc(left)) & BigInt(Math.trunc(right)),
      ),
    ),
  or: (left: number, right: number): number =>
    Number(
      BigInt.asIntN(
        64,
        BigInt(Math.trunc(left)) | BigInt(Math.trunc(right)),
      ),
    ),
  exclusiveOr: (left: number, right: number): number =>
    Number(
      BigInt.asIntN(
        64,
        BigInt(Math.trunc(left)) ^ BigInt(Math.trunc(right)),
      ),
    ),
  not: (value: number): number =>
    Number(BigInt.asIntN(64, ~BigInt(Math.trunc(value)))),
  shiftLeft: (value: number, count: number): number =>
    Number(
      BigInt.asIntN(
        64,
        BigInt(Math.trunc(value)) << BigInt(Math.trunc(count)),
      ),
    ),
  // arithmetic (sign-preserving), matching the compiled backends
  shiftRight: (value: number, count: number): number =>
    Number(
      BigInt.asIntN(
        64,
        BigInt(Math.trunc(value)) >> BigInt(Math.trunc(count)),
      ),
    ),
  shiftRightUnsigned: (value: number, count: number): number =>
    Number(
      BigInt.asUintN(64, BigInt(Math.trunc(value))) >>
        BigInt(Math.trunc(count)),
    ),
  // A SIGNED 32-BIT MULTIPLY WITH WRAPAROUND. `Math.imul` exactly: the high bits are DISCARDED, which is what
  // the classic string hashes are defined in terms of. The other ops here are 64-bit through BigInt; this one is
  // deliberately not, because a 64-bit product would give a different number and cyrb53 would stop being cyrb53.
  multiply32: (left: number, right: number): number =>
    Math.imul(Math.trunc(left), Math.trunc(right)),
}
