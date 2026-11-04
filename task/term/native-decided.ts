// The stdlib natives ABSENT ON PURPOSE, by a recorded decision, keyed `<backend>/<module>`. Read by
// task/term/native-surface.ts (which fails an entry whose module turns up) and task/term/native-gate.ts (which prints a
// module whose closure loads one as a named `decided` skip instead of failing it on the names the load would have given).

const FIND_SEND_ABSENT =
  'a native build reaches a find driver by a direct native call (AX, UIA, AT-SPI under native/{macos,windows,linux}/find/, spec section 2 "direct native call, later"), not written yet, and kotlin has no OS env to get one; a child-process host is a later stopgap item (note/project/term/find/decision/006-native-builds-wait-for-direct-drivers.md)'

// Not a hole to hide one in: each is printed on every run with its reason, and an entry whose module turns up (or
// whose baseline goes away) FAILS native-surface, so the list cannot outlive the decision
export const DECIDED: Record<string, string> = {
  'rust/text/format':
    'Rust\'s standard library carries no CLDR locale data, so a Rust build that loads @term/base/text/format is refused at the load until the data is chosen (note/project/term/decisions-2026-10/decisions-2026-10.md, D7)',
  // find's driver seam: a native build reaches a driver by a DIRECT native call (note/project/term/find/spec.md
  // section 2, "direct native call, later"), under native/{macos,windows,linux}/find/, not yet written
  'rust/find/send': FIND_SEND_ABSENT,
  'swift/find/send': FIND_SEND_ABSENT,
  'kotlin/find/send': FIND_SEND_ABSENT,
}
