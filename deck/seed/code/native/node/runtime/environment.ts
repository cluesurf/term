// Environment over the host process. The working directory and environment variables, presented as one namespace so
// the native module docks it as a <global:environment> and forwards uniformly, matching the rust, swift, and kotlin
// shims. A missing variable reads as the empty string, so the public API stays total.
const environment = {
  currentDirectory: (): string => process.cwd(),
  getVariable: (name: string): string => process.env[name] ?? '',
}
