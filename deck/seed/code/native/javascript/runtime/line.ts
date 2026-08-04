// Array-backed list runtime. Iteration, mapping and filtering all need a callback, which the seed source cannot write
// inline, so each takes the callback as an ordinary argument and the loop lives here. Reached only through the public
// list API.
const line = {
  get: (self: unknown[], position: number): unknown => self[position],

  set: (self: unknown[], position: number, item: unknown): void => {
    self[position] = item
  },

  size: (self: unknown[]): number => self.length,

  push: (self: unknown[], item: unknown): number => self.push(item),

  reverse: (self: unknown[]): unknown[] => self.reverse(),

  walk: (
    self: unknown[],
    step: (item: unknown, position: number) => void,
  ): void => {
    self.forEach((item, position) => step(item, position))
  },

  map: (
    self: unknown[],
    hook: (item: unknown, position: number) => unknown,
  ): unknown[] => self.map((item, position) => hook(item, position)),

  filter: (
    self: unknown[],
    hook: (item: unknown, position: number) => boolean,
  ): unknown[] => self.filter((item, position) => hook(item, position)),

  findFirst: (
    self: unknown[],
    hook: (item: unknown, position: number) => boolean,
  ): unknown => self.find((item, position) => hook(item, position)),
}
