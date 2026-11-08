// Runtime shape checks. The type system cannot answer these, so they are a platform capability like any other:
// the host is asked what a value actually is. Reached only through the public shape API.
//
// `typeOf` answers in Term's words, the same on every backend: `null`, `list`, `text`, `boolean`, `number` or
// `object` (item term-self-host-001-1089). JavaScript's own `typeof` said `string`, `undefined`, `bigint` and
// `function`, which no other backend answers.
const shape = {
  isList: (value: unknown): boolean => Array.isArray(value),
  // the same answer as typeOf's `number`, on every backend (item term-self-host-001-1091)
  isNumber: (value: unknown): boolean =>
    typeof value === 'number' || typeof value === 'bigint',
  isText: (value: unknown): boolean => typeof value === 'string',
  isNull: (value: unknown): boolean =>
    value === null || value === undefined,
  typeOf: (value: unknown): string =>
    value === null || value === undefined
      ? 'null'
      : Array.isArray(value)
        ? 'list'
        : typeof value === 'string'
          ? 'text'
          : typeof value === 'boolean'
            ? 'boolean'
            : typeof value === 'number' || typeof value === 'bigint'
              ? 'number'
              : 'object',
  isPresent: (value: unknown): boolean =>
    value !== null && value !== undefined,
}
