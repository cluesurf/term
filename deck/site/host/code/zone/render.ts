export type Maybe =
  | { form: "some"; value: T }
  | { form: "none" }

export function listIsEmpty<T>(self: T[]): boolean {
  return self.length == 0
}

export function listPush<T>(self: T[], item: T): number {
  return self.push(item)
}

export function listPop<T>(self: T[]): T {
  return self.pop()
}

export function listGet<T>(self: T[], index: number): T {
  return self.at(index)
}

export function listFindIndex<T>(self: T[], test: (a0: T) => boolean): number {
  return self.findIndex(test)
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

export function listFind<T>(self: Pair[], test: (a0: Pair) => boolean): Maybe {
  const index = listFindIndex(self, test)
  if (index >= 0) {
    return { form: "some", value: listGet(self, index) }
  } else {
    return { form: "none" }
  }
}

export interface View {
  handle: number
}

export interface Element {
  tag: string
  text: string
  value: string
  attributes: number[]
  styles: number[]
  classes: number[]
  children: number[]
  listeners: number[]
  parent: Maybe
}

export interface Pair {
  name: string
  value: string
}

export interface Listener {
  event: string
  handle: () => void
}

export function createElement(tag: string): View {
  return { handle: { tag: tag, text: "", value: "", attributes: [], styles: [], classes: [], children: [], listeners: [], parent: { form: "none" } } }
}

export function createText(value: string): View {
  return { handle: { tag: "", text: value, value: "", attributes: [], styles: [], classes: [], children: [], listeners: [], parent: { form: "none" } } }
}

export function setText(node: View, value: string): number {
  node.handle.text = value
}

export function setAttribute(node: View, name: string, value: string): number {
  const self = node.handle
  const kept = listFilter(self.attributes, (entry: Pair) => (entry.name != name))
  self.attributes = kept
  listPush(self.attributes, { name: name, value: value })
}

export function getAttribute(node: View, name: string): string {
  const self = node.handle
  const found = listFind(self.attributes, (entry: Pair) => (entry.name == name))
  if (found.form === "some") {
    return found.value.value
  } else if (found.form === "none") {
    return ""
  }
}

export function setStyle(node: View, property: string, value: string): number {
  listPush(node.handle.styles, { name: property, value: value })
}

export function addClass(node: View, name: string): number {
  listPush(node.handle.classes, name)
}

export function removeClass(node: View, name: string): number {
  const self = node.handle
  const kept = listFilter(self.classes, (entry: string) => (entry != name))
  self.classes = kept
}

export function setProperty(node: View, name: string, value: string): number {
  setAttribute(node, name, value)
}

export function listen(node: View, event: string, handler: () => void): number {
  listPush(node.handle.listeners, { event: event, handle: handler })
}

export function append(parent: View, child: View): number {
  listPush(parent.handle.children, child)
  child.handle.parent = { form: "some", value: parent }
}

export function remove(node: View): number {
  const self = node.handle
  const edge = self.parent
  if (edge.form === "some") {
    const owner = edge.value.handle
    const kept = listFilter(owner.children, (entry: View) => (entry != node))
    owner.children = kept
  } else if (edge.form === "none") {
    return
  }
}

export function replace(old: View, new_: View): number {
  old.handle = new_.handle
}

export function setValue(node: View, value: string): number {
  node.handle.value = value
}

export interface Signal {
  value: T
  observers: number[]
}

export interface Effect {
  run: () => void
  live: boolean
}

const running = []

const owners = []

export function readSignal<T>(self: Signal): T {
  track(self)
  return self.value
}

export function writeSignal<T>(self: number, value: T): number {
  self.value = value
  const subscribers = self.observers
  self.observers = []
  for (const observer of subscribers) {
    runEffect(observer)
  }
}

export function makeEffect(run: () => void): Effect {
  const own = { run: run, live: true }
  if (listIsEmpty(owners)) {
    const skip = 0
  } else {
    const top = listGet(owners, owners.length - 1)
    listPush(top, own)
  }
  runEffect(own)
  return own
}

export function runEffect(effect: Effect): number {
  if (effect.live) {
    listPush(running, effect)
    effect.run()
    listPop(running)
  } else {
    const skip = 0
  }
}

export function openScope(): number[] {
  const scope = []
  listPush(owners, scope)
  return scope
}

export function closeScope(): number {
  listPop(owners)
}

export function disposeScope(scope: number[]): number {
  for (const member of scope) {
    member.live = false
  }
}

export function track(signal: Signal): number {
  if (listIsEmpty(running)) {
    const skip = 0
  } else {
    const index = running.length - 1
    const current = listGet(running, index)
    listPush(signal.observers, current)
  }
}

export function element(tag: string): View {
  return createElement(tag)
}

export function text(value: string): View {
  return createText(value)
}

export function attribute(node: View, name: string, value: string): number {
  setAttribute(node, name, value)
}

export function event(node: View, name: string, handler: () => void): number {
  listen(node, name, handler)
}

export function dynamic(source: () => string): View {
  const host = { handle: { tag: "", text: "", value: "", attributes: [], styles: [], classes: [], children: [], listeners: [], parent: { form: "none" } } }
  makeEffect(() => {
  setText(host, source())
})
  return host
}

export function show(host: View, when: () => boolean, then: () => View, other: () => View): number {
  let current = { handle: { tag: "", text: "", value: "", attributes: [], styles: [], classes: [], children: [], listeners: [], parent: { form: "none" } } }
  append(host, current)
  makeEffect(() => {
  const next = when() ? then() : other()
  replace(current, next)
  current = next
})
}

export function each<T>(host: View, items: () => number[], build: (a0: number) => View): number {
  let mounted = []
  makeEffect(() => {
  for (const old of mounted) {
    remove(old)
  }
  const fresh = []
  const current = items()
  for (const item of current) {
    const node = build(item)
    append(host, node)
    listPush(fresh, node)
  }
  mounted = fresh
})
}

export function mount(host: View, build: () => View): number {
  append(host, build())
}
