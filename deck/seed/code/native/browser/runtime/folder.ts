// Standard folders for the Web platform. A browser has no user folders, so every one resolves to the origin, which is
// the only location a page can address. Reached only through the public environment API.
const folder = {
  home: (): string => location.origin,
  temporary: (): string => location.origin,
  data: (): string => location.origin,
  configuration: (): string => location.origin,
  cache: (): string => location.origin,
}
