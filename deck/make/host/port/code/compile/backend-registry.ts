export function listIsEmpty<T>(self: T[]): boolean {
  return self.length === 0
}

export interface BackendInfo {
  name: string
  language: string
  stability: string
  limitations: string[]
}

const backends: BackendInfo[] = [{ name: "typescript", language: "TypeScript", stability: "stable", limitations: ([] as string[]) }, { name: "rust", language: "Rust", stability: "stable", limitations: ([] as string[]) }, { name: "swift", language: "Swift", stability: "stable", limitations: ([] as string[]) }, { name: "kotlin", language: "Kotlin", stability: "stable", limitations: ([] as string[]) }, { name: "wgsl", language: "WGSL", stability: "experimental", limitations: ["Numeric-only by design: no strings, maps, records, closures, or async. It targets the GPU data-parallel fragment (numbers, floats, booleans, and arrays of them)."] }, { name: "hvm", language: "HVM", stability: "experimental", limitations: ["The pure fragment is lowered: numbers, booleans, arithmetic / comparison, named-function calls, recursion, and value conditionals (an `if` becomes a numeric match). Strings, collections, records, stored closures, and loops are not yet lowered and are flagged with a SEED-UNSUPPORTED marker."] }]

export function listBackends(): BackendInfo[] {
  return backends
}

export function isExperimentalBackend(name: string): boolean {
  for (const info of backends) {
    if (info.name === name) {
      return info.stability === "experimental"
    }
  }
  return false
}

export function experimentalNotice(name: string): string[] {
  const out: string[] = ([] as string[])
  for (const info of backends) {
    if (info.name === name && info.stability === "experimental") {
      out.push(`EXPERIMENTAL backend: ${info.language}. Output is not production-ready.`)
      for (const line of info.limitations) {
        out.push(`- ${line}`)
      }
    }
  }
  return out
}

export function experimentalBanner(name: string, prefix: string): string {
  const notice: string[] = experimentalNotice(name)
  if (listIsEmpty(notice)) {
    return ""
  }
  const lines: string[] = ([] as string[])
  for (const line of notice) {
    lines.push(`${prefix} ${line}`)
  }
  return `${lines.join("\n")}

`
}
