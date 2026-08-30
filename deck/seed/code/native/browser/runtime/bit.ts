// Bitwise integer operations over the Web platform, 64-bit like the compiled backends: each op runs
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
}
