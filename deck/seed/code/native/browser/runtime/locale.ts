// Locale runtime for the Web platform. Reached only through the public environment API.
const locale = {
  tag: (): string => navigator.language,
  timezone: (): string =>
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
  preferred: (): string[] => Array.from(navigator.languages),
}
