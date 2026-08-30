// Every bound a document has a number for, in one place.
//
// A closed vocabulary stops a document doing something we did not write. It does not stop it doing something we
// DID write, ten million times. Rendering a long list is legitimate, so the answer is a number rather than a
// refusal, and the number lives here so there is one place to read it and one place to change it.
//
// Every cap has a message naming which cap was hit. A cap with no message is a bug report nobody can act on.
//
// The counts are taken on the EXPANDED document, after `fuse`. A document with twenty fuses of a ten-node macro is
// a two-hundred-node document, and the count before expansion describes nothing a browser will build.
//
// See note/term/view/05-sandbox.md.

export type ViewCaps = {
  // nodes in the expanded document
  node: number
  // how deep the node tree may nest
  deep: number
  // `call` expressions nested inside one value
  callDeep: number
  // `call` expressions in the whole document
  callSum: number
  // what one `walk list` counts as when its length is not known until the query resolves. A counted walk over a
  // literal range contributes its real bound instead.
  walkWide: number
  // `walk` inside `walk` inside `walk`
  walkDeep: number
  // the product of the bounds of nested counted walks, which is what a browser actually builds
  walkSum: number
  // statements of one kind, so a document cannot have ten thousand queries
  find: number
  host: number
  view: number
}

// The defaults. Chosen to be generous for a document a person wrote and tight enough that a machine-generated one
// is caught, and deliberately low enough on the nesting bounds that they fire before anything else does.
export const VIEW_CAPS: ViewCaps = {
  node: 4000,
  deep: 32,
  callDeep: 4,
  callSum: 500,
  walkWide: 1000,
  walkDeep: 3,
  walkSum: 100000,
  find: 64,
  host: 256,
  view: 64,
}

export function capMessage(
  cap: keyof ViewCaps,
  said: number,
  caps: ViewCaps = VIEW_CAPS,
): string {
  const limit = caps[cap]

  switch (cap) {
    case 'node':
      return `this document builds ${said} nodes and the cap is ${limit}. Counted after macros expand, which is what a browser builds`
    case 'deep':
      return `this document nests ${said} deep and the cap is ${limit}`
    case 'callDeep':
      return `this value nests ${said} calls and the cap is ${limit}. A document formats a value, it does not compute one`
    case 'callSum':
      return `this document applies ${said} operators and the cap is ${limit}`
    case 'walkWide':
      return `a list walk is assumed to draw ${limit} items when its length is only known once the query resolves`
    case 'walkDeep':
      return `this document nests ${said} walks and the cap is ${limit}`
    case 'walkSum':
      return `these nested walks build up to ${said} nodes and the cap is ${limit}. One walk is bounded by its list, three are bounded by their product`
    case 'find':
      return `this document names ${said} queries and the cap is ${limit}`
    case 'host':
      return `this document names ${said} values and the cap is ${limit}`
    case 'view':
      return `this document declares ${said} views and the cap is ${limit}`
  }
}
