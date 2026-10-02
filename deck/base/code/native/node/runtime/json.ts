// JSON over the host JSON. The parsed value is the opaque dynamic value (any); the accessors navigate it directly.
const json = {
  parse: (text: string): any => JSON.parse(text),
  stringify: (value: any): string => JSON.stringify(value),
  getField: (value: any, key: string): any =>
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    key in value
      ? value[key]
      : null,
  getItem: (value: any, index: number): any =>
    Array.isArray(value) && index >= 0 && index < value.length
      ? value[index]
      : null,
  asNumber: (value: any): number =>
    typeof value === 'number' ? value : 0,
  asText: (value: any): string =>
    typeof value === 'string' ? value : '',
  asBoolean: (value: any): boolean =>
    typeof value === 'boolean' ? value : false,
  isNull: (value: any): boolean =>
    value === null || value === undefined,
  makeObject: (): any => ({}),
  setField: (value: any, key: string, field: any): any => {
    value[key] = field
    return value
  },
  makeArray: (): any => [],
  pushItem: (value: any, item: any): any => {
    value.push(item)
    return value
  },
  fromText: (value: string): any => value,
  fromNumber: (value: number): any => value,
  fromBoolean: (value: boolean): any => value,
  makeNull: (): any => null,
  // the shape questions a reader of foreign JSON asks: what is this value, and what does it hold
  isArray: (value: any): boolean => Array.isArray(value),
  isObject: (value: any): boolean =>
    value !== null && typeof value === 'object' && !Array.isArray(value),
  isText: (value: any): boolean => typeof value === 'string',
  isBoolean: (value: any): boolean => typeof value === 'boolean',
  arraySize: (value: any): number => (Array.isArray(value) ? value.length : 0),
  arrayItem: (value: any, index: number): any =>
    Array.isArray(value) && index >= 0 && index < value.length
      ? value[index]
      : null,
  objectKeys: (value: any): string[] =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value)
      : [],
}
