// Working directory runtime for the Web platform. A browser has no working directory, so the URL path stands in for
// it. Reached only through the public environment API.
const directory = {
  get: (): string => location.pathname,
  set: (path: string): void => history.pushState(null, '', path),
}
