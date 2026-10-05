export interface ViewCaps {
  node: number
  deep: number
  callDeep: number
  callSum: number
  walkWide: number
  walkDeep: number
  walkSum: number
  find: number
  host: number
  view: number
}

export function makeViewCaps(): ViewCaps {
  return { node: 4000, deep: 32, callDeep: 4, callSum: 500, walkWide: 1000, walkDeep: 3, walkSum: 100000, find: 64, host: 256, view: 64 }
}

export function capMessage(cap: string, said: number, caps: ViewCaps = makeViewCaps()): string {
  if (cap === "node") {
    return `this document builds ${said} nodes and the cap is ${caps.node}. Counted after macros expand, which is what a browser builds`
  }
  if (cap === "deep") {
    return `this document nests ${said} deep and the cap is ${caps.deep}`
  }
  if (cap === "callDeep") {
    return `this value nests ${said} calls and the cap is ${caps.callDeep}. A document formats a value, it does not compute one`
  }
  if (cap === "callSum") {
    return `this document applies ${said} operators and the cap is ${caps.callSum}`
  }
  if (cap === "walkWide") {
    return `a list walk is assumed to draw ${caps.walkWide} items when its length is only known once the query resolves`
  }
  if (cap === "walkDeep") {
    return `this document nests ${said} walks and the cap is ${caps.walkDeep}`
  }
  if (cap === "walkSum") {
    return `these nested walks build up to ${said} nodes and the cap is ${caps.walkSum}. One walk is bounded by its list, three are bounded by their product`
  }
  if (cap === "find") {
    return `this document names ${said} queries and the cap is ${caps.find}`
  }
  if (cap === "host") {
    return `this document names ${said} values and the cap is ${caps.host}`
  }
  if (cap === "view") {
    return `this document declares ${said} views and the cap is ${caps.view}`
  }
  return ""
}
