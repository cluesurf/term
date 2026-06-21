export interface View {
  handle: number
}

export function createElement(tag: string): View {}

export function createText(value: string): View {}

export function setText(node: View, value: string): number {}

export function setAttribute(node: View, name: string, value: string): number {}

export function getAttribute(node: View, name: string): string {}

export function setStyle(node: View, property: string, value: string): number {}

export function addClass(node: View, name: string): number {}

export function removeClass(node: View, name: string): number {}

export function setProperty(node: View, name: string, value: string): number {}

export function listen(node: View, event: string, handler: () => void): number {}

export function append(parent: View, child: View): number {}

export function remove(node: View): number {}

export function replace(old: View, new_: View): number {}

export function childCount(node: View): number {}

export function getValue(node: View): string {}

export function setValue(node: View, value: string): number {}
