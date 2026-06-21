const page = document

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
  const canvas = page.getElementById(id)
  const made = canvas.getContext("webgl2")
  return { handle: made }
}

export function size(pane: Surface, width: number, height: number): number {
  const gl = pane.handle
  gl.viewport(0, 0, width, height)
}

export function clear(pane: Surface, red: number, green: number, blue: number, alpha: number): number {
  const gl = pane.handle
  gl.clearColor(red, green, blue, alpha)
  gl.clear(gl.colorBufferBit)
}

export function makeStage(gl: WebGl2RenderingContext, typeCode: number, source: string): Shader {
  const made = gl.createShader(typeCode)
  gl.shaderSource(made, source)
  gl.compileShader(made)
  return { handle: made }
}

export function makeShader(pane: Surface, kind: ShaderKind, source: string): Shader {
  const gl = pane.handle
  if (kind.form === "vertex") {
    return makeStage(gl, gl.vertexShader, source)
  } else if (kind.form === "fragment") {
    return makeStage(gl, gl.fragmentShader, source)
  }
}

export function makeProgram(pane: Surface, vertex: Shader, fragment: Shader): Program {
  const gl = pane.handle
  const made = gl.createProgram()
  gl.attachShader(made, vertex.handle)
  gl.attachShader(made, fragment.handle)
  gl.linkProgram(made)
  return { handle: made }
}

export function makeBuffer(pane: Surface, data: number[]): GpuBuffer {
  const gl = pane.handle
  const made = gl.createBuffer()
  gl.bindBuffer(gl.arrayBuffer, made)
  gl.bufferData(gl.arrayBuffer, data, gl.staticDraw)
  return { handle: made }
}

export function draw(pane: Surface, prog: Program, verts: GpuBuffer, count: number): number {
  const gl = pane.handle
  gl.useProgram(prog.handle)
  gl.bindBuffer(gl.arrayBuffer, verts.handle)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.float, false, 0, 0)
  gl.drawArrays(gl.triangles, 0, count)
}
