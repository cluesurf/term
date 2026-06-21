// Bitwise integer operations over the node host. The JavaScript bitwise operators are 32-bit; keep operands within 32
// bits on this target. Reached only through the public bit API.
const bit = {
  and: (left: number, right: number): number => left & right,
  or: (left: number, right: number): number => left | right,
  exclusiveOr: (left: number, right: number): number => left ^ right,
  not: (value: number): number => ~value,
  shiftLeft: (value: number, count: number): number => value << count,
  shiftRight: (value: number, count: number): number => value >> count,
}
