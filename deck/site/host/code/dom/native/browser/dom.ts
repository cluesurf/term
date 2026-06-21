const page = document

export type Maybe =
  | { form: "some"; value: T }
  | { form: "none" }

export interface View {
  handle: number
}

export function createElement(tag: string): View {
  const made = page.createElement(tag, { form: "none" })
  return { handle: made }
}

export function createText(value: string): View {
  const made = page.createTextNode(value)
  return { handle: made }
}

export function setText(node: View, value: string): number {
  node.handle.textContent = value
}

export function setAttribute(node: View, name: string, value: string): number {
  const made = node.handle
  made.setAttribute(name, value)
}

export function listen(node: View, event: string, handler: () => void): number {
  const made = node.handle
  const listener = handler
  made.addEventListener(event, listener, { form: "none" })
}

export function append(parent: View, child: View): number {
  const made = parent.handle
  made.appendChild(child.handle)
}

export function replace(old: View, new_: View): number {
  const made = old.handle
  made.replaceWith(new_.handle)
}

export function remove(node: View): number {
  const made = node.handle
  made.remove()
}

export function getValue(node: View): string {
  return node.handle.value
}

export function setValue(node: View, value: string): number {
  node.handle.value = value
}
