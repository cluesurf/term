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

export function listFind<T>(self: number[], test: (a0: number) => boolean): Maybe {
  const index = listFindIndex(self, test)
  if (index >= 0) {
    return { form: "some", value: listGet(self, index) }
  } else {
    return { form: "none" }
  }
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

export function makeSignal<T>(value: number): Signal {
  return { value: value, observers: [] }
}

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
