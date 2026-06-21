export interface Surface {
  handle: number
}

export interface Shader {
  handle: number
}

export interface Program {
  handle: number
}

export interface GpuBuffer {
  handle: number
}

export type ShaderKind =
  | { form: "vertex" }
  | { form: "fragment" }
