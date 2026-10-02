// Calendar over the host Date, all in UTC. Timestamps are epoch milliseconds. Formatting uses Date.toISOString
// (always millisecond precision with a Z suffix); parsing uses Date.parse over the same ISO 8601 shape.
const calendar = {
  format: (millis: number): string => new Date(millis).toISOString(),
  parse: (text: string): number => Date.parse(text),
  year: (millis: number): number => new Date(millis).getUTCFullYear(),
  month: (millis: number): number => new Date(millis).getUTCMonth() + 1,
  day: (millis: number): number => new Date(millis).getUTCDate(),
  hour: (millis: number): number => new Date(millis).getUTCHours(),
  minute: (millis: number): number => new Date(millis).getUTCMinutes(),
  second: (millis: number): number => new Date(millis).getUTCSeconds(),
  weekday: (millis: number): number => new Date(millis).getUTCDay(),
  build: (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
  ): number => Date.UTC(year, month - 1, day, hour, minute, second),
  addMonths: (millis: number, count: number): number => {
    const date = new Date(millis)
    date.setUTCMonth(date.getUTCMonth() + count)
    return date.getTime()
  },
  addYears: (millis: number, count: number): number => {
    const date = new Date(millis)
    date.setUTCFullYear(date.getUTCFullYear() + count)
    return date.getTime()
  },
}
