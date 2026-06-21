export type Maybe =
  | { form: "some"; value: T }
  | { form: "none" }

export function listPush<T>(self: T[], item: T): number {
  return self.push(item)
}

export function listGet<T>(self: T[], index: number): T {
  return self.at(index)
}

export function listFindIndex<T>(self: T[], test: (a0: T) => boolean): number {
  return self.findIndex(test)
}

export function listJoin<T>(self: T[], separator: string): string {
  return self.join(separator)
}

export function listReverse<T>(self: T[]): T[] {
  return self.toReversed()
}

export function listConcat<T>(self: T[], other: T[]): T[] {
  return self.concat(other)
}

export function listSlice<T>(self: T[], start: number, end: number): T[] {
  return self.slice(start, end)
}

export function listMap<T, S>(self: T[], call: (a0: T) => S): S[] {
  return self.map(call)
}

export function listFilter<T>(self: T[], test: (a0: T) => boolean): T[] {
  return self.filter(test)
}

export function listFirst<T>(self: T[]): Maybe {
  if (self.length > 0) {
    return { form: "some", value: self.at(0) }
  } else {
    return { form: "none" }
  }
}

export function listLast<T>(self: T[]): Maybe {
  if (self.length > 0) {
    return { form: "some", value: self.at(self.length - 1) }
  } else {
    return { form: "none" }
  }
}

export function listTakeFirst<T>(self: T[], count: number): T[] {
  return self.slice(0, count)
}

export function listDropFirst<T>(self: T[], count: number): T[] {
  return self.slice(count)
}

export function listFlatten<T>(self: T[]): T[] {
  return self.flat()
}

export function listSum<T>(self: number[]): number {
  let total = 0
  for (const value of self) {
    total = total + value
  }
  return total
}

export function listProduct<T>(self: number[]): number {
  let total = 1
  for (const value of self) {
    total = total * value
  }
  return total
}

export function listUnique<T>(self: number[]): number[] {
  const out = []
  for (const value of self) {
    const seen = out.includes(value)
    if (seen == false) {
      out.push(value)
    }
  }
  return out
}

export function listFind<T>(self: number[], test: (a0: number) => boolean): Maybe {
  const index = listFindIndex(self, test)
  if (index >= 0) {
    return { form: "some", value: listGet(self, index) }
  } else {
    return { form: "none" }
  }
}

export function hashGet<K, V>(self: Map<K, V>, key: K): Maybe {
  if (self.has(key)) {
    return { form: "some", value: self.get(key) }
  } else {
    return { form: "none" }
  }
}

export function hashSet<K, V>(self: Map<K, V>, key: K, value: V): Map<K, V> {
  return self.set(key, value)
}

export function hashKeys<K, V>(self: Map<K, V>): K[] {
  return Array.from(self.keys())
}

export function hashValues<K, V>(self: Map<K, V>): V[] {
  return Array.from(self.values())
}

export function split(value: string, delimiter: string): number[] {
  return value.split(delimiter)
}

export type Encoding =
  | { form: "ascii" }
  | { form: "base-64" }
  | { form: "hex" }
  | { form: "latin-1" }
  | { form: "utf-8" }
  | { form: "utf-16" }
  | { form: "utf-16-be" }
  | { form: "utf-16-le" }
  | { form: "utf-32" }

export function doReplace(input: string, from: string, to: string): string {
  return input.replaceAll(from, to)
}

export interface Request {
  method: string
  path: string
  body: string
}

export interface Response {
  status: number
  body: string
}

export interface Route {
  method: string
  path: string
  handle: (a0: Request, a1: Map<number, number>) => Response
}

export interface ParamSpec {
  index: number
  name: string
  rest: boolean
}

export interface HandlerData {
  handle: (a0: Request, a1: Map<number, number>) => Response
  params: number[]
}

export interface Node {
  static: Map<number, number>
  param: Maybe
  paramName: string
  wildcard: Maybe
  wildcardName: string
  handlers: Map<string, HandlerData>
}

export interface Server {
  root: Node
}

export function emptyNode(): Node {
  return { static: new Map([]), param: { form: "none" }, paramName: "", wildcard: { form: "none" }, wildcardName: "", handlers: new Map([]) }
}

export function isWildcard(segment: string): boolean {
  return segment.startsWith("*")
}

export function paramNameOf(segment: string): string {
  const bare = doReplace(segment.replaceAll(":", ""), "*", "")
  if (bare == "") {
    return "rest"
  } else {
    return bare
  }
}

export function childOrEmpty(slot: Maybe): Node {
  if (slot.form === "some") {
    return slot.value
  } else if (slot.form === "none") {
    return emptyNode()
  }
}

export function addRoute(root: Node, method: string, path: string, handle: (a0: Request, a1: Map<number, number>) => Response): number {
  const segments = split(path, "/")
  let node = root
  const specs = []
  let index = 0
  for (const segment of segments) {
    if (isWildcard(segment)) {
      const child = childOrEmpty(node.wildcard)
      node.wildcard = { form: "some", value: child }
      node.wildcardName = paramNameOf(segment)
      listPush(specs, { index: index, name: paramNameOf(segment), rest: true })
      node = child
      break
    } else {
      if (segment.startsWith(":")) {
        const child = childOrEmpty(node.param)
        node.param = { form: "some", value: child }
        node.paramName = paramNameOf(segment)
        listPush(specs, { index: index, name: paramNameOf(segment), rest: false })
        node = child
      } else {
        const existing = hashGet(node.static, segment)
        if (existing.form === "some") {
          node = existing.value
        } else if (existing.form === "none") {
          const fresh = emptyNode()
          hashSet(node.static, segment, fresh)
          node = fresh
        }
      }
    }
    index = index + 1
  }
  hashSet(node.handlers, method, { handle: handle, params: specs })
}

export function routeServer(routes: number[]): Server {
  const root = emptyNode()
  for (const r of routes) {
    addRoute(root, r.method, r.path, r.handle)
  }
  return { root: root }
}

export function findNode(node: Node, method: string, segments: number[], index: number): Maybe {
  if (index >= segments.length) {
    return hashGet(node.handlers, method)
  } else {
    const segment = listGet(segments, index)
    const next = index + 1
    const staticChild = hashGet(node.static, segment)
    if (staticChild.form === "some") {
      const via = findNode(staticChild.value, method, segments, next)
      if (via.form === "some") {
        return via
      } else if (via.form === "none") {
        0
      }
    } else if (staticChild.form === "none") {
      0
    }
    const paramChild = node.param
    if (paramChild.form === "some") {
      const via = findNode(paramChild.value, method, segments, next)
      if (via.form === "some") {
        return via
      } else if (via.form === "none") {
        0
      }
    } else if (paramChild.form === "none") {
      0
    }
    const wildChild = node.wildcard
    if (wildChild.form === "some") {
      const wildNode = wildChild.value
      return hashGet(wildNode.handlers, method)
    } else if (wildChild.form === "none") {
      0
    }
    return { form: "none" }
  }
}

export function bindParams(specs: number[], segments: number[], into: Map<number, number>): Map<number, number> {
  for (const spec of specs) {
    if (spec.rest) {
      hashSet(into, spec.name, listJoin(listDropFirst(segments, spec.index), "/"))
    } else {
      hashSet(into, spec.name, listGet(segments, spec.index))
    }
  }
  return into
}

export function handleRequest(server: Server, request: Request): Response {
  const segments = split(request.path, "/")
  const found = findNode(server.root, request.method, segments, 0)
  if (found.form === "some") {
    const params = bindParams(found.value.params, segments, new Map([]))
    return found.value.handle(request, params)
  } else if (found.form === "none") {
    return { status: 404, body: "not found" }
  }
}

export function serve(server: Server, port: number): number {}
