// Runtime shape checks. The type system cannot answer these, so they are a platform capability like any other:
// the host is asked what a value actually is. Reached only through the public shape API.
const shape = {
  isList: (value: unknown): boolean => Array.isArray(value),
  isText: (value: unknown): boolean => typeof value === 'string',
  isNull: (value: unknown): boolean => value === null || value === undefined,
  typeOf: (value: unknown): string =>
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'list'
        : typeof value,
  isPresent: (value: unknown): boolean =>
    value !== null && value !== undefined,
}
