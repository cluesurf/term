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

export function open(id: string): Surface {
  return { handle: 0 }
}

export function size(pane: Surface, width: number, height: number): number {}

export function clear(pane: Surface, red: number, green: number, blue: number, alpha: number): number {}

export function makeShader(pane: Surface, kind: ShaderKind, source: string): Shader {
  return { handle: 0 }
}

export function makeProgram(pane: Surface, vertex: Shader, fragment: Shader): Program {
  return { handle: 0 }
}

export function makeBuffer(pane: Surface, data: number[]): GpuBuffer {
  return { handle: 0 }
}

export function draw(pane: Surface, prog: Program, verts: GpuBuffer, count: number): number {}
